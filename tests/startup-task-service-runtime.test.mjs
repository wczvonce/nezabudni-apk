import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });

const requests = [];
const closedConnections = [];
globalThis.indexedDB = {
  open(name) {
    const opened = {
      name,
      close() { closedConnections.push(name); },
      objectStoreNames: { contains: () => true },
    };
    const request = { result: opened };
    requests.push(request);
    return request;
  },
};

const {
  initTaskService,
  closeTaskService,
} = await import('../src/services/startup-task-service.js');

const first = initTaskService({ userId: 'user-a', demoMode: true, pairId: 'pair-a' });
const firstRejected = assert.rejects(
  first,
  (error) => error?.code === 'IDB_OPEN_BLOCKED',
  'blokovaný prvý účet musí skončiť rozpoznateľnou chybou',
);

// Nechaj prvý init vstúpiť do indexedDB.open(), potom simuluj odhlásenie.
await Promise.resolve();
assert.equal(requests.length, 1, 'prvý účet musí mať rozpracované otvorenie databázy');

// Odhlásenie nesmie čakať na blokovaný open a nový účet sa môže zaradiť hneď.
await closeTaskService();
const second = initTaskService({ userId: 'user-b', demoMode: true, pairId: 'pair-b' });

assert.equal(requests.length, 1, 'druhý init čaká iba dovtedy, kým sa prvý bezpečne ukončí');
requests[0].onblocked();
await firstRejected;

for (let i = 0; i < 20 && requests.length < 2; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(requests.length, 2, 'po zlyhaní prvého open sa musí spustiť inicializácia druhého účtu');
requests[1].onsuccess();
await second;

await closeTaskService();
assert.ok(closedConnections.includes('nezabudni-v19-user-b'), 'spojenie druhého účtu sa musí dať korektne zatvoriť');

console.log('STARTUP TASK SERVICE RUNTIME OK');
