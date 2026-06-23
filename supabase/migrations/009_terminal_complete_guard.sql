-- Nezabudni v19 – terminálny stav sa nesmie spätne zmeniť na completed.
-- Spusti po migrácii 008.

create or replace function public.api_complete_task(p_task_id uuid, p_mutation_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_task public.tasks;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if v_task.id is null or v_task.pair_id is distinct from public.current_pair_id() then
    raise exception 'TASK_NOT_FOUND';
  end if;
  if v_task.assigned_to <> v_user then
    raise exception 'ONLY_ASSIGNEE_CAN_COMPLETE';
  end if;
  if public.mutation_is_duplicate(p_mutation_id, 'complete', p_task_id) then
    return v_task;
  end if;
  if v_task.status = 'completed' then
    return v_task;
  end if;
  if v_task.deleted_at is not null then
    raise exception 'TASK_DELETED';
  end if;
  if v_task.status <> 'pending' then
    raise exception 'TASK_NOT_COMPLETABLE';
  end if;

  update public.tasks
  set status = 'completed',
      completed_by = v_user,
      completed_at = now(),
      acknowledged_by = v_user,
      acknowledged_at = coalesce(acknowledged_at, now()),
      updated_at = now(),
      version = version + 1,
      last_changed_by = v_user
  where id = p_task_id
  returning * into v_task;

  perform public.cancel_task_notification_jobs(p_task_id);
  insert into public.task_events(task_id, pair_id, actor_id, event_type)
  values(v_task.id, v_task.pair_id, v_user, 'completed');

  if v_task.notify_creator_on_complete and v_task.created_by <> v_task.assigned_to then
    insert into public.notification_jobs(task_id, recipient_id, kind, scheduled_at, dedupe_key)
    values(v_task.id, v_task.created_by, 'task_completed', now(), 'task-completed:' || v_task.id)
    on conflict(dedupe_key) do nothing;
  end if;

  if v_task.recurrence_rule <> 'none' and v_task.recurrence_mode = 'after' then
    perform public.create_next_recurring_task(v_task);
  end if;

  return v_task;
end;
$$;
