export function createTtlCache({ limit }) {
  const entries = new Map();

  return {
    get(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs = Number.POSITIVE_INFINITY, now = Date.now()) {
      entries.delete(key);
      if (entries.size >= limit) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, expiresAt: now + ttlMs });
    },
  };
}
