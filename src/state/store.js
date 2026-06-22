const initial = {
  booted: false,
  demoMode: false,
  user: null,
  profile: null,
  pair: null,
  members: [],
  tasks: [],
  activeTab: 'today',
  editingTaskId: null,
  currentAlarmTaskId: null,
  syncing: false,
  syncError: null,
  failedOutboxCount: 0,
  notificationStatus: null,
};

let state = structuredClone(initial);
const listeners = new Set();

export function getState() { return state; }
export function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}
export function updateState(updater) {
  setState(updater(state));
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function resetState() {
  state = structuredClone(initial);
  for (const fn of listeners) fn(state);
}
