// Issue 7: jednotná, testovateľná logika limitov lokálnych pripomienok.
export const MIN_REMINDER_INTERVAL_MS = 60_000;

export function reminderIntervalMs(task) {
  const seconds = Number(task?.reminder_interval_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return MIN_REMINDER_INTERVAL_MS;
  return Math.max(MIN_REMINDER_INTERVAL_MS, seconds * 1000);
}

export function isTerminalTask(task) {
  return !task || task.status !== 'pending' || Boolean(task.deleted_at) || Boolean(task.acknowledged_at);
}

export function maxReminders(task) {
  const max = Number(task?.max_reminders);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
}

/**
 * Smie lokálny alarm TERAZ zobraziť pripomienku pre danú úlohu a príjemcu?
 * Rešpektuje: terminálny stav, priradenie, rozpočet (shownCount < max_reminders),
 * čas splatnosti a interval od poslednej lokálnej pripomienky.
 */
export function localAlarmAllowed(task, { userId, now, dueMs, lastShownAt = 0, shownCount = 0 } = {}) {
  if (isTerminalTask(task)) return false;
  if (userId != null && task.assigned_to !== userId) return false;
  const max = maxReminders(task);
  if (max <= 0) return false;
  // SPOLOČNÝ rozpočet upozornení (audit A3): „Najviac 5×" znamená 5 upozornení
  // SPOLU — serverové pushe (reminders_sent, prežije reštart appky) + lokálne
  // in-app alarmy (shownCount). Bez toho by používateľ dostal až dvojnásobok
  // a po reštarte appky ďalšie (lokálne počítadlo sa nuluje, serverové nie).
  const sent = Number(task.reminders_sent);
  const used = shownCount + (Number.isFinite(sent) && sent > 0 ? sent : 0);
  if (used >= max) return false;                             // rozpočet vyčerpaný
  if (!Number.isFinite(dueMs) || dueMs > now) return false;  // ešte nie je čas
  return (now - lastShownAt) >= reminderIntervalMs(task);     // interval
}
