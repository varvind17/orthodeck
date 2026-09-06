// Tiny promise wrapper over IndexedDB. All user data lives here, on-device.
const DB = (() => {
  const NAME = 'orthodeck';
  const VERSION = 3;
  const STORES = ['progress', 'overrides', 'usercards', 'settings', 'chats', 'stats', 'queue', 'log'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((s) => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      try { result = fn(s); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
    getAll: (store) => tx(store, 'readonly', (s) => s.getAll()),
    put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
    putMany: (store, values) => tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
    del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
    clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
    stores: STORES
  };
})();
