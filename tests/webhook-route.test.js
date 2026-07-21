const { test, describe } = require("node:test");
const assert = require("node:assert");

const { createDeliveryCache } = require("../src/routes/webhooks");

describe("createDeliveryCache", () => {
  test("remembers processed delivery IDs", () => {
    const cache = createDeliveryCache();
    assert.strictEqual(cache.has("d1"), false);
    cache.add("d1");
    assert.strictEqual(cache.has("d1"), true);
  });

  test("ignores null/undefined IDs", () => {
    const cache = createDeliveryCache();
    cache.add(null);
    cache.add(undefined);
    assert.strictEqual(cache.has(null), false);
  });

  test("evicts oldest entries beyond max size", () => {
    const cache = createDeliveryCache(3);
    cache.add("a"); cache.add("b"); cache.add("c"); cache.add("d");
    assert.strictEqual(cache.has("a"), false, "oldest should be evicted");
    assert.strictEqual(cache.has("b"), true);
    assert.strictEqual(cache.has("d"), true);
  });

  test("re-adding an existing ID does not double-count", () => {
    const cache = createDeliveryCache(2);
    cache.add("a"); cache.add("a"); cache.add("b");
    assert.strictEqual(cache.has("a"), true);
    assert.strictEqual(cache.has("b"), true);
  });
});
