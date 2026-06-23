const DB_PREFIX = 'nezabudni-v19';
const VERSION = 1;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB chyba'));
  });
}

function databaseOpenError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * IndexedDB open môže pri poškodenej alebo blokovanej databáze zostať visieť bez
 * success/error udalosti. Tento wrapper má vlastný limit a pri neskorom success
 * už otvorenú databázu okamžite zavrie, aby nevzniklo osirelé spojenie.
 */
function openRequestToPromise(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    };
    const timeoutId = setTimeout(() => {
      finishReject(databaseOpenError('Otvorenie lokálnej databázy trvá príliš dlho.', 'IDB_OPEN_TIMEOUT'));
    }, timeoutMs);

    request.onsuccess = () => {
      const opened = request.result;
      if (settled) {
        opened?.close?.();
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(opened);
    };
    request.onerror = () => finishReject(request.error ?? databaseOpenError('IndexedDB chyba', 'IDB_OPEN_FAILED'));
    request.onblocked = () => finishReject(databaseOpenError('Lokálna databáza je blokovaná iným otvoreným procesom.', 'IDB_OPEN_BLOCKED'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transakcia zlyhala'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transakcia bola zrušená'));
  });
}

export class UserDatabase {
  constructor(userId, { openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS } = {}) {
    this.userId = userId;
    this.openTimeoutMs = openTimeoutMs;
    this.db = null;
    this.openPromise = null;
    this.generation = 0;
  }

  async open() {
    if (this.db) return this.db;
    if (this.openPromise) return this.openPromise;

    const generation = this.generation;
    const promise = (async () => {
      const safeUserId = String(this.userId).replace(/[^a-zA-Z0-9-]/g, '_');
      const req = indexedDB.open(`${DB_PREFIX}-${safeUserId}`, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outbox')) {
          const outbox = db.createObjectStore('outbox', { keyPath: 'mutation_id' });
          outbox.createIndex('created_at', 'created_at');
        }
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
      };

      const opened = await openRequestToPromise(req, this.openTimeoutMs);
      if (generation !== this.generation) {
        opened.close();
        throw databaseOpenError('Otvorenie lokálnej databázy bolo zrušené.', 'IDB_OPEN_CANCELLED');
      }

      opened.onversionchange = () => {
        opened.close();
        if (this.db === opened) this.db = null;
      };
      this.db = opened;
      return opened;
    })();

    this.openPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.openPromise === promise) this.openPromise = null;
    }
  }

  async close() {
    this.generation += 1;
    if (this.db) this.db.close();
    this.db = null;
  }

  async putTasks(tasks) {
    const db = await this.open();
    const tx = db.transaction('tasks', 'readwrite');
    const store = tx.objectStore('tasks');
    for (const task of tasks) store.put(task);
    await transactionDone(tx);
  }

  async replaceTasks(tasks) {
    const db = await this.open();
    const tx = db.transaction('tasks', 'readwrite');
    const store = tx.objectStore('tasks');
    store.clear();
    for (const task of tasks) store.put(task);
    await transactionDone(tx);
  }

  async getTasks() {
    const db = await this.open();
    return requestToPromise(db.transaction('tasks').objectStore('tasks').getAll());
  }

  async deleteTask(id) {
    const db = await this.open();
    const tx = db.transaction('tasks', 'readwrite');
    tx.objectStore('tasks').delete(id);
    await transactionDone(tx);
  }

  async enqueue(mutation) {
    const db = await this.open();
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put(mutation);
    await transactionDone(tx);
  }

  async outboxItems() {
    const db = await this.open();
    const items = await requestToPromise(db.transaction('outbox').objectStore('outbox').getAll());
    return items.filter((item) => item.status !== 'failed').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  async failedOutboxItems() {
    const db = await this.open();
    const items = await requestToPromise(db.transaction('outbox').objectStore('outbox').getAll());
    return items.filter((item) => item.status === 'failed').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  async removeOutbox(mutationId) {
    const db = await this.open();
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(mutationId);
    await transactionDone(tx);
  }

  async saveAttachment(record) {
    const db = await this.open();
    const tx = db.transaction('attachments', 'readwrite');
    tx.objectStore('attachments').put(record);
    await transactionDone(tx);
  }

  async getAttachment(id) {
    const db = await this.open();
    return requestToPromise(db.transaction('attachments').objectStore('attachments').get(id));
  }
}
