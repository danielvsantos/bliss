/**
 * Minimal in-memory stand-in for the ioredis commands the Enable Banking
 * helpers use (#132): SET … EX … NX, GETDEL, GET, MGET, INCR, and TTL for the
 * eToro "Sync now" cooldown (#143). Keys never expire; TTL reports the
 * seconds given to SET … EX.
 */
export function createFakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    async set(key: string, value: string, ...args: string[]) {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      const ex = args.indexOf('EX');
      if (ex >= 0) ttls.set(key, Number(args[ex + 1]));
      return 'OK';
    },
    async ttl(key: string) {
      if (!store.has(key)) return -2;
      return ttls.has(key) ? ttls.get(key)! : -1;
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
