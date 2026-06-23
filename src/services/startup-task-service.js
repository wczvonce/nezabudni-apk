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
let transitionTail = Promise.resolve();

function contextChangedError() {
  const error = new Error('Používateľský účet sa počas inicializácie zmenil.');
  error.code = 'ACCOUNT_CONTEXT_CHANGED';
  return error;
}

function enqueueTransition(operation) {
  const run = transitionTail.catch(() => {}).then(operation);
  transitionTail = run.catch(() => {});
  return run;
}

/**
 * Inicializácie a zatvárania lokálnej DB sa vykonávajú sériovo.
 * Ak staré otvorenie IndexedDB dobehne po timeoute alebo po zmene účtu,
 * pred ďalšou inicializáciou sa zatvorí a nesmie zostať aktívnym kontextom.
 */
export function initTaskService(options) {
  const generation = ++desiredGeneration;
  return enqueueTransition(async () => {
    if (generation !== desiredGeneration) throw contextChangedError();
    await rawInitTaskService(options);
    if (generation !== desiredGeneration) {
      await rawCloseTaskService();
      throw contextChangedError();
    }
  });
}

export function closeTaskService() {
  ++desiredGeneration;
  return enqueueTransition(() => rawCloseTaskService());
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
