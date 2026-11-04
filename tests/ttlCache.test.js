import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../ttlCache.js";

test("ttl cache returns a value until it expires", () => {
  const cache = createTtlCache({ limit: 10 });
  cache.set("k", { kind: "invalid" }, 1000, 0);
  assert.deepEqual(cache.get("k", 999), { kind: "invalid" });
  assert.equal(cache.get("k", 1000), undefined);
});

test("expired entries are removed so a retry is possible", () => {
  const cache = createTtlCache({ limit: 10 });
  cache.set("k", "v", 100, 0);
  assert.equal(cache.get("k", 200), undefined);
  cache.set("k", "again", 100, 200);
  assert.equal(cache.get("k", 250), "again");
});

test("entries without ttl do not expire", () => {
  const cache = createTtlCache({ limit: 10 });
  cache.set("k", "v", undefined, 0);
  assert.equal(cache.get("k", Number.MAX_SAFE_INTEGER), "v");
});

test("cache evicts the oldest entry when the limit is reached", () => {
  const cache = createTtlCache({ limit: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
});

test("setting an existing key does not evict another entry", () => {
  const cache = createTtlCache({ limit: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.get("b"), 2);
});
