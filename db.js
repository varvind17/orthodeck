// Tiny promise wrapper over IndexedDB. All user data lives here, on-device.
//
// Every record in a synced store carries `u`, the millisecond timestamp of its
// last local write. sync.js merges phone and laptop by taking the newer `u` for
// each record, so the stamp has to be applied on every write — which is why it
// happens here rather than at each call site. Pass { stamp: false } when
// writing records that already carry a timestamp from the other device.
const DB = (() => {
  const NAME = 'orthodeck';
  const VERSION = 4;
  const STORES = ['progress', 'overrides', 'usercards', 'settings', 'chats', 'stats', 'queue', 'log', 'tombstones'];
  // 'log' is append-only and 'chats' are device-local, so neither needs stamping.
  const SYNCED = ['progress', 'overrides', 'usercards', 'settings', 'stats', 'queue'];
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

  const stamp = (store, v, opts) => {
    if (!v || typeof v !== 'object') return v;
    if (opts && opts.stamp === false) return v;
    if (SYNCED.indexOf(store) === -1) return v;
    v.u = Date.now();
    return v;
  };

  return {
    get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
    getAll: (store) => tx(store, 'readonly', (s) => s.getAll()),
    put: (store, value, opts) => tx(store, 'readwrite', (s) => s.put(stamp(store, value, opts))),
    putMany: (store, values, opts) => tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(stamp(store, v, opts))); }),
    // A delete has to survive sync too, or the other device would simply put the
    // record back. Deletes in synced stores leave a dated tombstone behind;
    // sync.js treats it as just another record competing on `u`.
    del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)).then((r) =>
      SYNCED.indexOf(store) === -1 ? r
        : tx('tombstones', 'readwrite', (t) => t.put({ id: store + ':' + id, store, key: String(id), u: Date.now() })).then(() => r)),
    clear: (store) => tx(store, 'readonly', (s) => s.getAllKeys()).then((keys) =>
      tx(store, 'readwrite', (s) => s.clear()).then(() =>
        SYNCED.indexOf(store) === -1 ? undefined
          : tx('tombstones', 'readwrite', (t) => { const u = Date.now(); keys.forEach((k) => t.put({ id: store + ':' + k, store, key: String(k), u })); }))),
    // Delete without leaving a tombstone — used by sync.js when applying a
    // delete that came from the other device.
    delRaw: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
    stores: STORES,
    synced: SYNCED
  };
})();
