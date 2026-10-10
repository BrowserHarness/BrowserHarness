// Failure modes of a learned operation against the local fixture shop: each
// answer gets the right class, nothing old is returned as new, and a write
// whose fate is unknown is never sent again.
import assert from "node:assert/strict";
import test from "node:test";
import { startApiShop } from "./fixtures/api-shop.mjs";
import { recordRun } from "./fixtures/record-run.mjs";
import { learnApiOperation } from "../src/api-engine/learn.mjs";
import { callTier1 } from "../src/api-engine/tier1.mjs";

const EXAMPLES = [{ q: "laptops" }, { q: "keyboards" }];

async function learned(shop) {
  const captures = [await recordRun(shop.origin, "rest", "laptops"), await recordRun(shop.origin, "rest", "keyboards")];
  return learnApiOperation({ name: "search", captures, examples: EXAMPLES }).contract;
}

function at(contract, origin, path, extra = {}) {
  return { ...contract, request: { ...contract.request, url: `${origin}${path}` }, slots: [], params: [], ...extra };
}

test("a rate limit is rate_limited, with no data and no retry", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop);
    shop.state.rateLimitRemaining = 0;
    const before = shop.state.requests.length;
    const answer = await callTier1(contract, { q: "monitors" }, { minIntervalMs: 0 });
    assert.equal(answer.class, "rate_limited");
    assert.equal(answer.ok, false);
    assert.equal(answer.data, undefined, "no earlier answer stands in for this one");
    assert.equal(shop.state.requests.length, before + 1, "sent once, not retried");
  } finally {
    await shop.close();
  }
});

test("a bot wall is blocked, not drift", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop);
    const answer = await callTier1(at(contract, shop.origin, "/challenge"), {}, { minIntervalMs: 0 });
    assert.equal(answer.class, "blocked", answer.reason);
  } finally {
    await shop.close();
  }
});

test("a site that is down is network for a read", async () => {
  const shop = await startApiShop();
  const contract = await learned(shop);
  const origin = shop.origin;
  await shop.close();
  const answer = await callTier1(contract, { q: "monitors" }, { minIntervalMs: 0, timeoutMs: 3000 });
  assert.equal(answer.class, "network");
  assert.equal(answer.ok, false);
  assert.ok(answer.reason || origin);
});

test("a write the server took and then hung up on is ambiguous and says not to resend", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop);
    const write = at(contract, shop.origin, "/api/hangup", {
      side_effect: "write",
      request: { method: "POST", url: `${shop.origin}/api/hangup`, headers: { "content-type": "application/json" }, body: '{"sku":"lt-1"}' }
    });
    const writes = shop.state.writes;
    const refused = await callTier1(write, {}, { minIntervalMs: 0 });
    assert.equal(refused.class, "approval_required");
    assert.equal(refused.sent, false);
    assert.equal(shop.state.writes, writes, "nothing sent without approval");

    const answer = await callTier1(write, {}, { approved: true, minIntervalMs: 0, timeoutMs: 3000 });
    assert.equal(answer.class, "ambiguous_write");
    assert.equal(answer.sent, true);
    assert.match(answer.next, /do not resend/);
    assert.equal(shop.state.writes, writes + 1, "sent exactly once");
  } finally {
    await shop.close();
  }
});

test("calls to one site are paced", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop);
    await callTier1(contract, { q: "monitors" }, { minIntervalMs: 300 });
    const started = performance.now();
    const answer = await callTier1(contract, { q: "tablets" }, { minIntervalMs: 300 });
    assert.equal(answer.ok, true, answer.reason);
    assert.ok(performance.now() - started >= 250, `second call waited ${Math.round(performance.now() - started)} ms`);
  } finally {
    await shop.close();
  }
});
