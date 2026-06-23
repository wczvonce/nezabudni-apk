import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'content-type': 'application/json; charset=utf-8',
};

type NotificationJob = {
  id: string;
  task_id: string | null;
  recipient_id: string;
  kind: 'task_pre' | 'task_due' | 'task_repeat' | 'task_completed' | 'task_assigned' | 'test';
  attempt_count: number;
  scheduled_at: string;
  dedupe_key: string;
};

type Task = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  deleted_at: string | null;
  acknowledged_at: string | null;
  assigned_to: string;
  completed_by: string | null;
  priority: number;
  due_at: string;
  snoozed_until: string | null;
  reminder_interval_seconds: number;
  max_reminders: number;
  version: number;
};

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers: corsHeaders });

  const expectedSecret = Deno.env.get('PUSH_WORKER_SECRET');
  const suppliedSecret = request.headers.get('x-worker-secret');
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401, headers: corsHeaders });
  }

  const supabaseUrl = mustEnv('SUPABASE_URL');
  const serviceRoleKey = mustEnv('SUPABASE_SERVICE_ROLE_KEY');
  const oneSignalKey = mustEnv('ONESIGNAL_REST_API_KEY');
  const oneSignalAppId = mustEnv('ONESIGNAL_APP_ID');
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Opakovania typu „v každom termíne“ generuje rovnaký chránený worker.
  const { error: recurrenceError } = await supabase.rpc('api_generate_recurring_occurrences');
  const recurrenceWarning = recurrenceError?.message ?? null;
  if (recurrenceError) console.error('Recurring occurrence generation failed', recurrenceError);

  const { data: jobs, error: claimError } = await supabase.rpc('claim_notification_jobs', { p_limit: 25 });
  if (claimError) return new Response(JSON.stringify({ error: claimError.message }), { status: 500, headers: corsHeaders });

  // Issue 2: ohraničený beh. Edge Function má časový limit – prestaň brať nové joby
  // pred jeho dosiahnutím; nedokončené zaclaimované joby sa nižšie bezpečne vrátia
  // do fronty pre ďalší beh (žiadny job sa nestratí).
  const claimedJobs = (jobs ?? []) as NotificationJob[];
  const startedAt = Date.now();
  const WORKER_DEADLINE_MS = 25_000;
  let deadlineReached = false;

  const results = [];
  for (const job of claimedJobs) {
    if (Date.now() - startedAt > WORKER_DEADLINE_MS) { deadlineReached = true; break; }
    try {
      const task = job.task_id ? await loadTask(supabase, job.task_id) : null;
      if (shouldCancel(job, task)) {
        const { error: cancelError } = await supabase
          .from('notification_jobs')
          .update({ status: 'cancelled', locked_at: null })
          .eq('id', job.id)
          .eq('status', 'processing');
        if (cancelError) throw cancelError;
        results.push({ id: job.id, status: 'cancelled' });
        continue;
      }

      const { data: subscriptions, error: subscriptionError } = await supabase
        .from('device_subscriptions')
        .select('subscription_id')
        .eq('user_id', job.recipient_id)
        .eq('active', true);
      if (subscriptionError) throw subscriptionError;
      const subscriptionIds = (subscriptions ?? []).map((row) => row.subscription_id).filter(Boolean);
      if (!subscriptionIds.length) throw new Error('NO_ACTIVE_SUBSCRIPTIONS');

      const message = await buildMessage(supabase, job, task);

      // Úloha mohla byť medzi načítaním a odoslaním odložená, upravená alebo
      // zrušená. Druhá kontrola tesne pred externým API výrazne zúži okno,
      // v ktorom by mohol odísť starý push.
      const { data: liveJob, error: liveJobError } = await supabase
        .from('notification_jobs')
        .select('status')
        .eq('id', job.id)
        .maybeSingle();
      if (liveJobError) throw liveJobError;
      if (liveJob?.status !== 'processing') {
        results.push({ id: job.id, status: 'cancelled-before-send' });
        continue;
      }

      const response = await fetch('https://api.onesignal.com/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Key ${oneSignalKey}`,
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          app_id: oneSignalAppId,
          target_channel: 'push',
          include_subscription_ids: subscriptionIds,
          headings: { en: message.heading, sk: message.heading },
          contents: { en: message.body, sk: message.body },
          data: { task_id: job.task_id, kind: job.kind },
          // Plánované pripomienky (task_pre/due/repeat) sú časovo citlivé – nasadíme
          // vysokú technickú prioritu (FCM high / OneSignal priority 10), aby zobudili
          // zariadenie z Doze. Ostatné správy ostávajú normálne (nezneužívame prioritu).
          priority: (isScheduledReminder(job.kind) || task?.priority === 3) ? 10 : 5,
          ios_interruption_level: (isScheduledReminder(job.kind) || task?.priority === 3) ? 'time_sensitive' : 'active',
          ttl: notificationTtl(job, task),
          // Rovnaký UUID sa používa pri každom retry tohto jobu. OneSignal tak
          // nevytvorí duplicitný push ani po timeout-e alebo páde workera.
          idempotency_key: job.id,
        }),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`ONESIGNAL_${response.status}: ${responseText}`);
      const parsed = safeJson(responseText);
      const messageId = typeof parsed?.id === 'string' ? parsed.id : null;
      if (!messageId) throw new Error(`ONESIGNAL_NO_MESSAGE_ID: ${responseText}`);
      const { error: sentError } = await supabase.rpc('mark_notification_sent', { p_job_id: job.id, p_message_id: messageId });
      if (sentError) throw sentError;
      results.push({ id: job.id, status: 'sent', messageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { error: failedError } = await supabase.rpc('mark_notification_failed', { p_job_id: job.id, p_error: message });
      if (failedError) console.error('Failed to persist notification error', job.id, failedError);
      results.push({ id: job.id, status: 'failed', error: message });
    }
  }

  // Issue 2: ktorýkoľvek zaclaimovaný job, ktorý sme nestihli dokončiť (deadline
  // alebo predčasný koniec), vráť do fronty. Dokončené joby už nie sú 'processing',
  // takže ich to nepoškodí – tým sa žiadny job nestratí pri ukončení invokácie.
  const claimedIds = claimedJobs.map((j) => j.id);
  if (claimedIds.length) {
    const { error: requeueError } = await supabase
      .from('notification_jobs')
      .update({ status: 'queued', locked_at: null })
      .in('id', claimedIds)
      .eq('status', 'processing');
    if (requeueError) console.error('Requeue of unfinished jobs failed', requeueError);
  }

  return new Response(JSON.stringify({ processed: results.length, claimed: claimedJobs.length, deadlineReached, recurrenceWarning, results }), { status: 200, headers: corsHeaders });
});


// Plánované, časovo citlivé pripomienky, ktoré majú spoľahlivo zobudiť zariadenie.
function isScheduledReminder(kind: NotificationJob['kind']): boolean {
  return kind === 'task_pre' || kind === 'task_due' || kind === 'task_repeat';
}

function notificationTtl(job: NotificationJob, task: Task | null): number {
  if (job.kind === 'test') return 300;
  if (job.kind === 'task_assigned' || job.kind === 'task_completed') return 86_400;
  // Reminder pushy sa opakujú zo servera. Krátke TTL zabráni tomu, aby sa po
  // dlhšom offline stave naraz zobrazila celá séria starých upozornení.
  const interval = Number(task?.reminder_interval_seconds ?? 60);
  return Math.min(900, Math.max(120, interval + 60));
}

function mustEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function safeJson(value: string): Record<string, unknown> | null {
  try { return JSON.parse(value); } catch { return null; }
}

async function loadTask(supabase: ReturnType<typeof createClient>, taskId: string): Promise<Task | null> {
  const { data, error } = await supabase.from('tasks').select('id,title,notes,status,deleted_at,acknowledged_at,assigned_to,completed_by,priority,due_at,snoozed_until,reminder_interval_seconds,max_reminders,version').eq('id', taskId).maybeSingle();
  if (error) throw error;
  return data as Task | null;
}

function shouldCancel(job: NotificationJob, task: Task | null): boolean {
  if (!task) return job.kind !== 'test';
  if (job.kind === 'task_completed') return false;
  if (['task_pre','task_due','task_repeat','task_assigned'].includes(job.kind) && task.assigned_to !== job.recipient_id) return true;
  if (task.deleted_at || task.status !== 'pending') return true;
  if (['task_pre','task_due','task_repeat','task_assigned'].includes(job.kind) && task.acknowledged_at) return true;

  // Dedupe kľúč nesie verziu úlohy. Ak bola úloha po zaradení jobu
  // upravená alebo odložená, starý job už nesmie odísť.
  const versionMatch = job.dedupe_key?.match(/:v(\d+)(?::|$)/);
  if (versionMatch && Number(versionMatch[1]) !== Number(task.version)) return true;

  const now = Date.now();
  const effectiveDue = new Date(task.snoozed_until || task.due_at).getTime();
  if (!Number.isFinite(effectiveDue)) return true;
  if (job.kind === 'task_pre' && now >= effectiveDue) return true;
  if (['task_due','task_repeat'].includes(job.kind) && now + 5_000 < effectiveDue) return true;

  // Ak zariadenie dlho nemalo subscription alebo bolo offline, neposielaj po
  // hodinách celú starú sériu. Bežná séria sa smie doručiť len v rozumnom
  // okne odvodenom od intervalu a maxima opakovaní, najviac 6 hodín.
  if (['task_due','task_repeat'].includes(job.kind)) {
    const sequenceMs = Number(task.reminder_interval_seconds || 60) * Number(task.max_reminders || 10) * 1000;
    const graceMs = Math.min(6 * 60 * 60_000, Math.max(15 * 60_000, sequenceMs + 10 * 60_000));
    if (now > effectiveDue + graceMs) return true;
  }
  return false;
}

async function buildMessage(supabase: ReturnType<typeof createClient>, job: NotificationJob, task: Task | null) {
  if (job.kind === 'test') return { heading: 'Nezabudni testovacia', body: 'Testovacia notifikácia funguje.' };
  if (!task) return { heading: 'Nezabudni', body: 'Máš novú pripomienku.' };
  if (job.kind === 'task_pre') return { heading: 'Pripomienka čoskoro', body: task.title };
  if (job.kind === 'task_repeat') return { heading: 'Stále čaká na potvrdenie', body: task.title };
  if (job.kind === 'task_completed') {
    let name = 'Partner';
    if (task.completed_by) {
      const { data } = await supabase.from('profiles').select('display_name').eq('id', task.completed_by).maybeSingle();
      if (data?.display_name) name = data.display_name;
    }
    return { heading: 'Úloha bola splnená', body: `${name} splnil/a: ${task.title}` };
  }
  if (job.kind === 'task_assigned') return { heading: 'Nová úloha od partnera', body: task.title };
  return { heading: 'Nezabudni', body: task.title };
}
