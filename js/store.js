// Saved letters live in IndexedDB so the alphabet survives a page refresh.

const Store = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('music-alphabet', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('letters', { keyPath: 'letter' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('letters', mode);
      const req = fn(t.objectStore('letters'));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    put: (rec) => tx('readwrite', (s) => s.put(rec)),
    getAll: () => tx('readonly', (s) => s.getAll()),
    clear: () => tx('readwrite', (s) => s.clear()),
  };
})();
