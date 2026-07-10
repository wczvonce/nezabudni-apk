const DB_PREFIX = 'nezabudni-v19';
const VERSION = 1;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB chyba'));
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
  constructor(userId) {
    this.userId = userId;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
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
    this.db = await requestToPromise(req);
    return this.db;
  }

  async close() {
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

  // Jednoduché per-účet key/value nastavenia (store 'settings' existuje od VERSION 1).
  async getSetting(key) {
    const db = await this.open();
    const row = await requestToPromise(db.transaction('settings').objectStore('settings').get(key));
    return row ? row.value : undefined;
  }

  async putSetting(key, value) {
    const db = await this.open();
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    await transactionDone(tx);
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
