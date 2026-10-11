/**
 * Minimal in-memory stand-in for the ioredis commands the Enable Banking
 * helpers use (#132): SET … EX … NX, GETDEL, GET, MGET, INCR. TTLs are ignored.
 */
export function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, ...args: string[]) {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async getdel(key: string) {
      const v = store.has(key) ? store.get(key)! : null;
      store.delete(key);
      return v;
    },
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async mget(...keys: string[]) {
      return keys.map((k) => (store.has(k) ? store.get(k)! : null));
    },
    async incr(key: string) {
      const n = Number(store.get(key) || 0) + 1;
      store.set(key, String(n));
      return n;
    },
  };
}
