import {
  initTaskService as rawInitTaskService,
  closeTaskService as rawCloseTaskService,
  cachedTasks,
  cacheTasks,
  fetchTasks as rawFetchTasks,
  flushOutbox as rawFlushOutbox,
} from './task-service.js';
import { withAbortTimeout } from '../lib/async.js';

const STARTUP_SYNC_TIMEOUT_MS = 20_000;

let desiredGeneration = 0;
let initTail = Promise.resolve();

function contextChangedError() {
  const error = new Error('Používateľský účet sa počas inicializácie zmenil.');
  error.code = 'ACCOUNT_CONTEXT_CHANGED';
  return error;
}

function enqueueInit(operation) {
  const run = initTail.catch(() => {}).then(operation);
  initTail = run.catch(() => {});
  return run;
}

/**
 * Otvárania lokálnej DB sa vykonávajú sériovo. Ak staré otvorenie IndexedDB
 * dobehne po timeoute alebo po zmene účtu, zatvorí sa ešte pred spustením
 * nasledujúcej inicializácie a nesmie zostať aktívnym kontextom.
 */
export function initTaskService(options) {
  const generation = ++desiredGeneration;
  return enqueueInit(async () => {
    if (generation !== desiredGeneration) throw contextChangedError();
    await rawInitTaskService(options);
    if (generation !== desiredGeneration) {
      await rawCloseTaskService();
      throw contextChangedError();
    }
  });
}

/**
 * Zatvorenie nesmie čakať na zaseknuté otvorenie IndexedDB. Aktívny kontext
 * odpojíme hneď a zvýšením generácie zneplatníme všetky rozpracované init pokusy.
 * Keď starý init neskôr dobehne, jeho vlastná kontrola ho bezpečne zatvorí.
 */
export function closeTaskService() {
  ++desiredGeneration;
  return rawCloseTaskService();
}

/**
 * Štartovacia synchronizácia sa chráni aj vlastným abortovateľným timeoutom.
 * main.js historicky preteká už spustený Promise, preto by bez tohto wrappera
 * AbortSignal nedorazil do task-service a oneskorený výsledok by mohol zapisovať.
 */
export function flushOutbox() {
  return withAbortTimeout((signal) => rawFlushOutbox(signal), {
    timeoutMs: STARTUP_SYNC_TIMEOUT_MS,
    message: 'Synchronizácia offline zmien trvá príliš dlho.',
  });
}

export function fetchTasks() {
  return withAbortTimeout((signal) => rawFetchTasks(signal), {
    timeoutMs: STARTUP_SYNC_TIMEOUT_MS,
    message: 'Načítanie úloh trvá príliš dlho.',
  });
}

export { cachedTasks, cacheTasks };
