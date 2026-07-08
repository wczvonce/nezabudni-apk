import { requireSupabase } from '../lib/supabase.js';
import { UserDatabase } from '../lib/idb.js';
import { CONFIG } from '../config.js';

let db = null;
let context = null;

function contextSnapshot() {
  if (!context || !db) throw new Error('Task service nie je inicializovaný.');
  return { context, db };
}

function assertCurrent(snapshot) {
  if (context !== snapshot.context || db !== snapshot.db) {
    const error = new Error('Používateľský účet sa počas operácie zmenil. Operáciu zopakuj.');
    error.code = 'ACCOUNT_CONTEXT_CHANGED';
    throw error;
  }
}

function uuid() {
  return crypto.randomUUID();
}

function isNetworkError(error) {
  if (!navigator.onLine) return true;
  if (error?.code === 'OPERATION_ABORTED' || error?.code === 'ACCOUNT_CONTEXT_CHANGED') return false;
  // Fetch zlyháva TypeError-om; supabase-js ho zabalí do message. Zámerne
  // presné vzory – serverová chyba, ktorá náhodou obsahuje slovo „network",
  // nesmie skončiť v offline fronte namiesto zobrazenia používateľovi.
  if (error instanceof TypeError) return true;
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('failed to fetch') || text.includes('networkerror') || text.includes('network request failed') || text.includes('load failed');
}

// Prechodná serverová chyba (5xx/429/expirovaný token) – mutácia ostane vo
// fronte a ďalší sync ju zopakuje automaticky; až po vyčerpaní pokusov sa
// označí ako 'failed' na ručné riešenie.
const MAX_OUTBOX_AUTO_RETRIES = 5;
function isTransientServerError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 429 || status >= 500) return true;
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('jwt expired') || text.includes('timeout') || text.includes('too many requests');
}

// Issue 9: operáciu spustenú cez withAbortTimeout treba po timeoute zastaviť skôr,
// než zapíše (už neaktuálny) výsledok do zdieľanej DB. Túto chybu nesmie pohltiť
// bežná catch vetva outboxu – preto vlastný kód, ktorý sa znovu vyhodí.
function operationAborted() {
  const error = new Error('Operácia bola zrušená (timeout).');
  error.code = 'OPERATION_ABORTED';
  return error;
}

// Epoch chráni pred dobiehajúcim initom: keď init(A) vytimeoutuje a medzitým
// prebehne close + init(B), oneskorené dokončenie A NESMIE prepnúť globálny
// kontext späť na A (inak by sa miešali účty a cache).
let initEpoch = 0;

export async function initTaskService({ userId, demoMode, pairId }) {
  const epoch = ++initEpoch;
  const nextContext = { userId, demoMode, pairId };
  const nextDb = new UserDatabase(userId);
  await nextDb.open();
  if (epoch !== initEpoch) { await nextDb.close()?.catch?.(() => {}); throw operationAborted(); }
  context = nextContext;
  db = nextDb;
}

export async function closeTaskService() {
  initEpoch += 1;
  const oldDb = db;
  // Najprv odpoj globálny kontext. Dobiehajúca odpoveď starého účtu tak
  // nikdy nemôže zapísať dáta do databázy nového účtu.
  db = null;
  context = null;
  await oldDb?.close();
}

export async function cachedTasks() {
  if (!db || !context) return [];
  const snapshot = contextSnapshot();
  const tasks = await snapshot.db.getTasks();
  assertCurrent(snapshot);
  return tasks;
}

export async function cacheTasks(tasks) {
  const snapshot = contextSnapshot();
  await snapshot.db.putTasks(tasks);
  assertCurrent(snapshot);
}

export async function fetchTasks(signal) {
  const snapshot = contextSnapshot();
  if (signal?.aborted) throw operationAborted();
  if (snapshot.context.demoMode || !navigator.onLine) {
    const tasks = await snapshot.db.getTasks();
    assertCurrent(snapshot);
    return tasks;
  }

  const sb = requireSupabase();
  const { data, error } = await sb
    .from('tasks')
    .select('*')
    .eq('pair_id', snapshot.context.pairId)
    .order('due_at', { ascending: true });
  if (error) throw error;
  assertCurrent(snapshot);
  // Issue 12: vynechaj úlohy, ktoré si používateľ odstránil zo svojho zoznamu.
  const { data: hiddenRows, error: hiddenError } = await sb.from('task_hidden').select('task_id');
  if (hiddenError) console.warn('Filter skrytých úloh zlyhal; zobrazujem všetky úlohy', hiddenError.message);
  const hidden = new Set((hiddenRows || []).map((r) => r.task_id));
  const visible = (data || []).filter((t) => !hidden.has(t.id));
  // Issue 9: dobehnuté po timeoute? Nezapisuj – novší sync už mohol uložiť čerstvý stav.
  if (signal?.aborted) throw operationAborted();
  await snapshot.db.replaceTasks(visible);
  assertCurrent(snapshot);
  return visible;
}

async function callRpc(action, payload) {
  const sb = requireSupabase();
  const rpcByAction = {
    create: 'api_create_task',
    update: 'api_update_task',
    complete: 'api_complete_task',
    acknowledge: 'api_acknowledge_task',
    snooze: 'api_snooze_task',
    delete: 'api_delete_task',
    reject: 'api_reject_task',
  };
  const name = rpcByAction[action];
  if (!name) throw new Error(`Neznáma operácia: ${action}`);
  const { data, error } = await sb.rpc(name, payload);
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

async function queueMutation(action, payload, optimisticTask, snapshot) {
  const mutationId = payload.p_mutation_id || uuid();
  payload.p_mutation_id = mutationId;
  const mutation = {
    mutation_id: mutationId,
    action,
    payload,
    created_at: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  assertCurrent(snapshot);
  await snapshot.db.enqueue(mutation);
  // Atomicita: ak optimistický zápis zlyhá (napr. plná kvóta IndexedDB), nesmie
  // ostať v outboxe osirelá mutácia bez zodpovedajúcej úlohy v zozname – vrátime ju späť.
  try {
    if (optimisticTask) await snapshot.db.putTasks([optimisticTask]);
  } catch (error) {
    await snapshot.db.removeOutbox(mutationId).catch(() => {});
    throw error;
  }
  assertCurrent(snapshot);
  return { task: optimisticTask, queued: true };
}

function demoTaskFromInput(input, existing = null, activeContext = context) {
  const now = new Date().toISOString();
  return {
    id: existing?.id || input.p_id || uuid(),
    pair_id: activeContext.pairId,
    created_by: existing?.created_by || activeContext.userId,
    assigned_to: input.p_assigned_to ?? existing?.assigned_to ?? activeContext.userId,
    title: input.p_title ?? existing?.title ?? '',
    // p_notes === null znamená „poznámky vymazané" — nesmie prepadnúť na staré.
    notes: 'p_notes' in input ? (input.p_notes ?? '') : (existing?.notes ?? ''),
    due_at: input.p_due_at ?? existing?.due_at ?? now,
    timezone: input.p_timezone ?? existing?.timezone ?? CONFIG.defaultTimezone,
    priority: Number(input.p_priority ?? existing?.priority ?? 1),
    pre_reminder_minutes: Number(input.p_pre_reminder_minutes ?? existing?.pre_reminder_minutes ?? 0),
    recurrence_rule: input.p_recurrence_rule ?? existing?.recurrence_rule ?? 'none',
    recurrence_mode: input.p_recurrence_mode ?? existing?.recurrence_mode ?? 'after',
    series_id: existing?.series_id || input.p_id || existing?.id || uuid(),
    occurrence_at: input.p_due_at ?? existing?.occurrence_at ?? existing?.due_at ?? now,
    notify_creator_on_complete: Boolean(input.p_notify_creator_on_complete ?? existing?.notify_creator_on_complete ?? false),
    reminder_interval_seconds: Number(input.p_reminder_interval_seconds ?? existing?.reminder_interval_seconds ?? 60),
    max_reminders: Number(input.p_max_reminders ?? existing?.max_reminders ?? 10),
    reminders_sent: existing?.reminders_sent ?? 0,
    status: existing?.status ?? 'pending',
    snoozed_until: existing?.snoozed_until ?? null,
    completed_by: existing?.completed_by ?? null,
    completed_at: existing?.completed_at ?? null,
    acknowledged_at: existing?.acknowledged_at ?? null,
    acknowledged_by: existing?.acknowledged_by ?? null,
    deleted_at: existing?.deleted_at ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    version: Number(existing?.version ?? 0) + 1,
    last_changed_by: activeContext.userId,
  };
}

export async function createTask(input, files = []) {
  const snapshot = contextSnapshot();
  if (!navigator.onLine && files.length) throw new Error('Prílohy sa dajú pridať až po pripojení na internet.');
  const id = input.id || uuid();
  const payload = {
    p_id: id,
    p_mutation_id: uuid(),
    p_assigned_to: input.assigned_to,
    p_title: input.title,
    p_notes: input.notes || null,
    p_due_at: input.due_at,
    p_timezone: input.timezone || CONFIG.defaultTimezone,
    p_priority: Number(input.priority || 1),
    p_pre_reminder_minutes: Number(input.pre_reminder_minutes || 0),
    p_recurrence_rule: input.recurrence_rule || 'none',
    p_recurrence_mode: input.recurrence_mode || 'after',
    p_notify_creator_on_complete: Boolean(input.notify_creator_on_complete),
    p_reminder_interval_seconds: Number(input.reminder_interval_seconds || 60),
    p_max_reminders: Number(input.max_reminders || 10),
  };

  if (snapshot.context.demoMode) {
    const task = demoTaskFromInput(payload, null, snapshot.context);
    await snapshot.db.putTasks([task]);
    await saveDemoAttachments(snapshot, task.id, files);
    return { task, queued: false };
  }

  const optimistic = demoTaskFromInput(payload, null, snapshot.context);
  if (!navigator.onLine) return queueMutation('create', payload, optimistic, snapshot);

  try {
    const task = await callRpc('create', payload);
    assertCurrent(snapshot);
    await snapshot.db.putTasks([task]);
    const attachmentErrors = files.length ? await uploadAttachments(task, files, snapshot) : [];
    return { task, queued: false, attachmentErrors };
  } catch (error) {
    // Prílohy sa do offline fronty nedajú zaradiť – používateľ sa to musí
    // dozvedieť, inak by sa potichu stratili (guard na vstupe kryje iba
    // stav offline PRED requestom, nie výpadok počas neho).
    if (isNetworkError(error)) return { ...(await queueMutation('create', payload, optimistic, snapshot)), attachmentsSkipped: files.length };
    throw error;
  }
}

export async function updateTask(task, input, files = []) {
  const snapshot = contextSnapshot();
  if (!navigator.onLine && files.length) throw new Error('Prílohy sa dajú pridať až po pripojení na internet.');
  const payload = {
    p_task_id: task.id,
    p_mutation_id: uuid(),
    p_expected_version: Number(task.version),
    p_assigned_to: input.assigned_to,
    p_title: input.title,
    p_notes: input.notes || null,
    p_due_at: input.due_at,
    p_timezone: input.timezone || CONFIG.defaultTimezone,
    p_priority: Number(input.priority || 1),
    p_pre_reminder_minutes: Number(input.pre_reminder_minutes || 0),
    p_recurrence_rule: input.recurrence_rule || 'none',
    p_recurrence_mode: input.recurrence_mode || 'after',
    p_notify_creator_on_complete: Boolean(input.notify_creator_on_complete),
    p_reminder_interval_seconds: Number(input.reminder_interval_seconds || 60),
    p_max_reminders: Number(input.max_reminders || 10),
  };
  const optimistic = demoTaskFromInput(payload, task, snapshot.context);

  if (snapshot.context.demoMode) {
    await snapshot.db.putTasks([optimistic]);
    await saveDemoAttachments(snapshot, task.id, files);
    return { task: optimistic, queued: false };
  }
  if (!navigator.onLine) return queueMutation('update', payload, optimistic, snapshot);

  try {
    const updated = await callRpc('update', payload);
    assertCurrent(snapshot);
    await snapshot.db.putTasks([updated]);
    const attachmentErrors = files.length ? await uploadAttachments(updated, files, snapshot) : [];
    return { task: updated, queued: false, attachmentErrors };
  } catch (error) {
    if (isNetworkError(error)) return { ...(await queueMutation('update', payload, optimistic, snapshot)), attachmentsSkipped: files.length };
    throw error;
  }
}

export async function completeTask(task) {
  const snapshot = contextSnapshot();
  const payload = { p_task_id: task.id, p_mutation_id: uuid() };
  const optimistic = { ...task, status: 'completed', completed_by: snapshot.context.userId, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: Number(task.version) + 1 };
  if (snapshot.context.demoMode) { await snapshot.db.putTasks([optimistic]); return { task: optimistic, queued: false }; }
  if (!navigator.onLine) return queueMutation('complete', payload, optimistic, snapshot);
  try {
    const updated = await callRpc('complete', payload);
    assertCurrent(snapshot);
    await snapshot.db.putTasks([updated]);
    return { task: updated, queued: false };
  } catch (error) {
    if (isNetworkError(error)) return queueMutation('complete', payload, optimistic, snapshot);
    throw error;
  }
}


export async function acknowledgeTask(task) {
  const snapshot = contextSnapshot();
  const payload = { p_task_id: task.id, p_mutation_id: uuid() };
  const optimistic = { ...task, acknowledged_at: new Date().toISOString(), acknowledged_by: snapshot.context.userId, updated_at: new Date().toISOString(), version: Number(task.version) + 1 };
  if (snapshot.context.demoMode) { await snapshot.db.putTasks([optimistic]); return { task: optimistic, queued: false }; }
  if (!navigator.onLine) return queueMutation('acknowledge', payload, optimistic, snapshot);
  try {
    const updated = await callRpc('acknowledge', payload);
    assertCurrent(snapshot);
    await snapshot.db.putTasks([updated]);
    return { task: updated, queued: false };
  } catch (error) {
    if (isNetworkError(error)) return queueMutation('acknowledge', payload, optimistic, snapshot);
    throw error;
  }
}

export async function snoozeTask(task, minutes) {
  const snapshot = contextSnapshot();
  const snoozedUntil = new Date(Date.now() + Number(minutes) * 60_000).toISOString();
  // Issue 6: pošli ABSOLÚTNY čas (vypočítaný teraz), aby ho server pri neskorej
  // synchronizácii neprepočítal zo svojho now() (drift offline snooze).
  const payload = { p_task_id: task.id, p_minutes: Number(minutes), p_mutation_id: uuid(), p_snoozed_until: snoozedUntil };
  const optimistic = { ...task, snoozed_until: snoozedUntil, reminders_sent: 0, updated_at: new Date().toISOString(), version: Number(task.version) + 1 };
  if (snapshot.context.demoMode) { await snapshot.db.putTasks([optimistic]); return { task: optimistic, queued: false }; }
  if (!navigator.onLine) return queueMutation('snooze', payload, optimistic, snapshot);
  try {
    const updated = await callRpc('snooze', payload);
    assertCurrent(snapshot);
    await snapshot.db.putTasks([updated]);
    return { task: updated, queued: false };
  } catch (error) {
    if (isNetworkError(error)) return queueMutation('snooze', payload, optimistic, snapshot);
    throw error;
  }
}

export async function deleteTask(task) {
  const snapshot = contextSnapshot();
  const payload = { p_task_id: task.id, p_mutation_id: uuid() };
  const optimistic = { ...task, status: 'cancelled', deleted_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: Number(task.version) + 1 };
  if (snapshot.context.demoMode) { await snapshot.db.putTasks([optimistic]); return { task: optimistic, queued: false }; }
  if (!navigator.onLine) return queueMutation('delete', payload, optimistic, snapshot);
  try {
    const updated = await callRpc('delete', payload);
    assertCurrent(snapshot);
    await snapshot.db.putTasks([updated]);
    return { task: updated, queued: false };
  } catch (error) {
    if (isNetworkError(error)) return queueMutation('delete', payload, optimistic, snapshot);
    throw error;
  }
}

// Issue 12: príjemca odmietne úlohu s POVINNÝM dôvodom.
export async function rejectTask(task, reason) {
  const snapshot = contextSnapshot();
  const trimmed = String(reason || '').trim();
  if (!trimmed) throw new Error('Uveď dôvod odmietnutia.');
  const payload = { p_task_id: task.id, p_reason: trimmed, p_mutation_id: uuid() };
  const optimistic = { ...task, status: 'rejected', rejection_reason: trimmed, rejected_by: snapshot.context.userId, rejected_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: Number(task.version) + 1 };
  if (snapshot.context.demoMode) { await snapshot.db.putTasks([optimistic]); return { task: optimistic, queued: false }; }
  if (!navigator.onLine) return queueMutation('reject', payload, optimistic, snapshot);
  try {
    const updated = await callRpc('reject', payload);
    assertCurrent(snapshot);
    await snapshot.db.putTasks([updated]);
    return { task: updated, queued: false };
  } catch (error) {
    if (isNetworkError(error)) return queueMutation('reject', payload, optimistic, snapshot);
    throw error;
  }
}

// Issue 12: príjemca odstráni terminálnu úlohu zo SVOJHO zoznamu (nemaže autorov záznam).
export async function hideTaskForSelf(task) {
  const snapshot = contextSnapshot();
  if (snapshot.context.demoMode) return { queued: false };
  const sb = requireSupabase();
  const { error } = await sb.rpc('api_hide_task_for_self', { p_task_id: task.id });
  if (error) throw error;
  assertCurrent(snapshot);
  return { queued: false };
}

// Single-flight: flush volá boot (priamo) aj syncNow — dve súbežné inštancie
// by si navzájom replayovali už odstránené mutácie a vyrábali fantómové
// 'failed' záznamy. Druhý volajúci počká na prebiehajúci flush.
let flushPromise = null;
export function flushOutbox(signal) {
  if (flushPromise) return flushPromise;
  flushPromise = flushOutboxInner(signal).finally(() => { flushPromise = null; });
  return flushPromise;
}

async function flushOutboxInner(signal) {
  const snapshot = contextSnapshot();
  if (snapshot.context.demoMode || !navigator.onLine) return { processed: 0, failed: 0, unresolved: 0 };
  if (signal?.aborted) throw operationAborted();
  const items = await snapshot.db.outboxItems();
  let processed = 0;
  let failed = 0;
  for (const item of items) {
    if (signal?.aborted) throw operationAborted();
    try {
      const task = await callRpc(item.action, item.payload);
      // Issue 9: dobehnuté po timeoute? Zahoď výsledok – inak prepíše novší sync.
      if (signal?.aborted) throw operationAborted();
      assertCurrent(snapshot);
      if (task) await snapshot.db.putTasks([task]);
      await snapshot.db.removeOutbox(item.mutation_id);
      processed += 1;
    } catch (error) {
      if (error?.code === 'ACCOUNT_CONTEXT_CHANGED' || error?.code === 'OPERATION_ABORTED') throw error;
      if (isNetworkError(error)) break;
      assertCurrent(snapshot);
      item.attempts = Number(item.attempts || 0) + 1;
      item.last_error = String(error?.message || error || 'UNKNOWN_ERROR');
      item.last_attempt_at = new Date().toISOString();
      // Prechodná serverová chyba (5xx/429/expirovaný token) sa nesmie po
      // JEDNOM pokuse natrvalo zaparkovať ako 'failed' – mutácia ostane
      // pending a ďalší sync ju zopakuje automaticky (s limitom pokusov).
      if (isTransientServerError(error) && item.attempts < MAX_OUTBOX_AUTO_RETRIES) {
        item.status = 'pending';
        await snapshot.db.enqueue(item);
        console.warn('Outbox mutation transiently failed; will retry on next sync', item.mutation_id, item.last_error);
        // Outbox je USPORIADANÁ fronta závislých mutácií (create X → update X).
        // Pokračovanie by replaylo závislé mutácie predčasne (update na ešte
        // neexistujúcej úlohe → natrvalo 'failed'), preto sa flush zastaví
        // a ďalší sync začne znova od hlavy.
        break;
      }
      // Jedna neplatná alebo konfliktná zmena nesmie navždy zablokovať
      // všetky neskoršie zmeny. Ponecháme ju v outboxe a ukážeme ju
      // používateľovi v nastaveniach na ručné zopakovanie alebo zahodenie.
      item.status = 'failed';
      await snapshot.db.enqueue(item);
      failed += 1;
      console.error('Outbox mutation failed', item, error);
    }
  }
  assertCurrent(snapshot);
  return { processed, failed, unresolved: (await snapshot.db.failedOutboxItems()).length };
}

export async function failedOutboxItems() {
  const snapshot = contextSnapshot();
  const items = await snapshot.db.failedOutboxItems();
  assertCurrent(snapshot);
  return items;
}

export async function retryFailedOutbox() {
  const snapshot = contextSnapshot();
  const items = await snapshot.db.failedOutboxItems();
  const cached = await snapshot.db.getTasks();
  for (const item of items) {
    // TASK_CONFLICT: pôvodná p_expected_version je už navždy zastaraná –
    // opakovanie s ňou by deterministicky zlyhalo. Rebase na aktuálnu
    // (serverovú) verziu z cache; používateľ o prepise rozhodol tlačidlom.
    if (item.action === 'update' && String(item.last_error || '').includes('TASK_CONFLICT')) {
      const current = cached.find((t) => t.id === item.payload?.p_task_id);
      if (current) item.payload.p_expected_version = Number(current.version);
    }
    item.status = 'pending';
    item.last_error = null;
    item.attempts = 0;
    await snapshot.db.enqueue(item);
  }
  assertCurrent(snapshot);
  return items.length;
}

export async function discardFailedOutbox() {
  const snapshot = contextSnapshot();
  const items = await snapshot.db.failedOutboxItems();
  for (const item of items) await snapshot.db.removeOutbox(item.mutation_id);
  assertCurrent(snapshot);
  return items.length;
}

async function uploadAttachments(task, files, snapshot) {
  const sb = requireSupabase();
  const errors = [];
  for (const file of files) {
    assertCurrent(snapshot);
    let path = null;
    try {
      if (file.size > CONFIG.maxAttachmentBytes) throw new Error(`Súbor ${file.name} je väčší než 10 MB.`);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      path = `${task.pair_id}/${task.id}/${uuid()}-${safeName}`;
      const { error: uploadError } = await sb.storage.from(CONFIG.attachmentBucket).upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
      if (uploadError) throw uploadError;
      assertCurrent(snapshot);
      const { error: rowError } = await sb.from('task_attachments').insert({
        task_id: task.id,
        pair_id: task.pair_id,
        uploaded_by: snapshot.context.userId,
        storage_path: path,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
      });
      assertCurrent(snapshot);
      if (rowError) {
        await sb.storage.from(CONFIG.attachmentBucket).remove([path]).catch(() => {});
        throw rowError;
      }
    } catch (error) {
      errors.push(`${file.name}: ${error?.message || error}`);
    }
  }
  return errors;
}

async function saveDemoAttachments(snapshot, taskId, files) {
  for (const file of files) {
    assertCurrent(snapshot);
    await snapshot.db.saveAttachment({ id: `${taskId}:${uuid()}`, task_id: taskId, filename: file.name, mime_type: file.type, size_bytes: file.size, blob: file });
  }
}

export async function fetchAttachments(taskId) {
  const snapshot = contextSnapshot();
  if (snapshot.context.demoMode) return [];
  const sb = requireSupabase();
  const { data, error } = await sb.from('task_attachments').select('*').eq('task_id', taskId).order('created_at');
  if (error) throw error;
  assertCurrent(snapshot);
  return data || [];
}

// Podpísaná (dočasná) URL na otvorenie prílohy — bucket je privátny.
export async function attachmentSignedUrl(storagePath) {
  const sb = requireSupabase();
  const { data, error } = await sb.storage.from(CONFIG.attachmentBucket).createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}
