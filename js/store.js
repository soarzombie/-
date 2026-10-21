// Measurement records in IndexedDB (on this phone only).

const DB_NAME = 'noise-meter';
const STORE = 'records';

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const putRecord = (rec) => run('readwrite', (s) => s.put(rec)).then(() => rec);
export const getRecord = (id) => run('readonly', (s) => s.get(id));
export const deleteRecord = (id) => run('readwrite', (s) => s.delete(id));
export const clearRecords = () => run('readwrite', (s) => s.clear());

// Newest first.
export async function allRecords() {
  const list = await run('readonly', (s) => s.getAll());
  return (list || []).sort((a, b) => b.ts - a.ts);
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
