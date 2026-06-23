import assert from 'node:assert/strict';
import { UserDatabase } from '../src/lib/idb.js';

function fakeOpenedDatabase(onClose = () => {}) {
  return {
    close: onClose,
    objectStoreNames: { contains: () => true },
  };
}

// 1) Open, ktorý nikdy nepošle success/error/blocked, musí skončiť timeoutom.
{
  let request;
  let lateConnectionClosed = false;
  globalThis.indexedDB = {
    open() {
      request = { result: fakeOpenedDatabase(() => { lateConnectionClosed = true; }) };
      return request;
    },
  };

  const db = new UserDatabase('timeout-user', { openTimeoutMs: 20 });
  await assert.rejects(
    db.open(),
    (error) => error?.code === 'IDB_OPEN_TIMEOUT',
    'zaseknuté IndexedDB open musí skončiť vlastným timeoutom',
  );

  request.onsuccess();
  assert.equal(lateConnectionClosed, true, 'oneskorene otvorené spojenie sa musí okamžite zavrieť');
}

// 2) onblocked musí zlyhať okamžite, nie nechať aplikáciu visieť.
{
  let request;
  globalThis.indexedDB = {
    open() {
      request = { result: fakeOpenedDatabase() };
      return request;
    },
  };

  const db = new UserDatabase('blocked-user', { openTimeoutMs: 1000 });
  const opening = db.open();
  request.onblocked();
  await assert.rejects(
    opening,
    (error) => error?.code === 'IDB_OPEN_BLOCKED',
    'blokovaná databáza musí vrátiť rozpoznateľnú chybu',
  );
}

// 3) close počas rozpracovaného open zneplatní neskorý výsledok.
{
  let request;
  let cancelledConnectionClosed = false;
  globalThis.indexedDB = {
    open() {
      request = { result: fakeOpenedDatabase(() => { cancelledConnectionClosed = true; }) };
      return request;
    },
  };

  const db = new UserDatabase('cancel-user', { openTimeoutMs: 1000 });
  const opening = db.open();
  await db.close();
  request.onsuccess();
  await assert.rejects(
    opening,
    (error) => error?.code === 'IDB_OPEN_CANCELLED',
    'zatvorenie musí zneplatniť rozpracované otvorenie',
  );
  assert.equal(cancelledConnectionClosed, true, 'zneplatnené spojenie sa musí zavrieť');
}

// 4) Súbežní volajúci jednej inštancie nesmú otvoriť dve databázové spojenia.
{
  let request;
  let openCalls = 0;
  globalThis.indexedDB = {
    open() {
      openCalls += 1;
      request = { result: fakeOpenedDatabase() };
      return request;
    },
  };

  const db = new UserDatabase('single-flight-user', { openTimeoutMs: 1000 });
  const first = db.open();
  const second = db.open();
  request.onsuccess();
  await Promise.all([first, second]);
  assert.equal(openCalls, 1, 'jedna UserDatabase inštancia otvára iba jedno spojenie naraz');
  await db.close();
}

console.log('IDB OPEN RESILIENCE OK');
