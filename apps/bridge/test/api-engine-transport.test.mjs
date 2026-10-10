// Tiers 2 and 3 on the Bridge side: the request a page sends, and the
// answers a page observed, judged with the same classifier as tier 1.
import assert from "node:assert/strict";
import test from "node:test";
import { startApiShop } from "./fixtures/api-shop.mjs";
import { recordRun } from "./fixtures/record-run.mjs";
import { learnApiOperation } from "../src/api-engine/learn.mjs";
import { callTier1 } from "../src/api-engine/tier1.mjs";
import { buildForPage, judgePageAnswer, judgePageRun, triggerFor } from "../src/api-engine/transport.mjs";

const EXAMPLES = [{ q: "laptops" }, { q: "keyboards" }];
const SID = [{ name: "sid", value: "valid-session-123456", domain: "127.0.0.1", path: "/" }];

async function learned(shop, kind, options = {}) {
  const captures = [await recordRun(shop.origin, kind, "laptops", options), await recordRun(shop.origin, kind, "keyboards", options)];
  return learnApiOperation({ name: kind, captures, examples: EXAMPLES, ...(options.learn || {}) }).contract;
}

/** What a page's fetch would observe: the request as built, sent with the page's cookies. */
async function sendLikeAPage(request, cookies = SID) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers, cookie: cookies.map((item) => `${item.name}=${item.value}`).join("; ") },
    ...(request.body !== undefined ? { body: request.body } : {}),
    redirect: "manual"
  });
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), url: request.url };
}

test("a signed-in read: plain HTTP has no session and answers auth; the page's request succeeds", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop, "orders", { cookies: SID });
    assert.ok(!JSON.stringify(contract).includes("valid-session-123456"));
    const tier1 = await callTier1(contract, { q: "monitors" }, { minIntervalMs: 0 });
    assert.equal(tier1.class, "auth");
    assert.equal(tier1.sent, true, "it was sent and refused");

    const plan = buildForPage(contract, { q: "monitors" }, { provided: { cookies: SID, storage: {} } });
    assert.equal(plan.refused, undefined);
    assert.equal(plan.page_origin, shop.origin);
    assert.match(plan.request.url, /\/api\/orders\?q=monitors/);
    for (const name of Object.keys(plan.request.headers)) assert.doesNotMatch(name, /^(cookie|user-agent|referer|host)$/i, `${name} is the page's own`);

    const answer = judgePageAnswer(contract, await sendLikeAPage(plan.request));
    assert.equal(answer.ok, true, answer.reason);
    assert.equal(answer.tier, 2);
    assert.deepEqual(answer.data.map((item) => item.id), ["m1", "m2"]);
  } finally {
    await shop.close();
  }
});

test("a page's redirect and a failed fetch: a read is drift or network, a write is never resent", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop, "rest");
    assert.equal(judgePageAnswer(contract, { redirected_opaque: true }).class, "endpoint_drift");
    assert.equal(judgePageAnswer(contract, { error: "Failed to fetch" }).class, "network");
    const write = { ...contract, side_effect: "write" };
    for (const observed of [{ redirected_opaque: true }, { error: "Failed to fetch" }]) {
      const answer = judgePageAnswer(write, observed);
      assert.equal(answer.class, "ambiguous_write");
      assert.equal(answer.sent, true);
      assert.match(answer.next, /do not resend/);
    }
    assert.equal(buildForPage(write, { q: "x1x" }, {}).refused.class, "approval_required");
    assert.equal(buildForPage(contract, {}, {}).refused.class, "input");
  } finally {
    await shop.close();
  }
});

test("a per-load signature makes min tier 3: tiers 1 and 2 refuse before sending, the page's own run answers", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop, "guarded");
    assert.equal(contract.min_tier, 3);
    const before = shop.state.requests.length;
    assert.equal((await callTier1(contract, { q: "monitors" }, { minIntervalMs: 0 })).class, "unavailable");
    assert.equal(buildForPage(contract, { q: "monitors" }, {}).refused.class, "unavailable");
    assert.equal(shop.state.requests.length, before, "nothing was sent");

    const trigger = triggerFor(contract, { q: "monitors" });
    assert.equal(trigger.url, `${shop.origin}/guarded?q=monitors`);
    // the page loads and makes its own request with a fresh signature
    const run = await recordRun(shop.origin, "guarded", "monitors");
    const answer = judgePageRun(contract, run);
    assert.equal(answer.ok, true, answer.reason);
    assert.equal(answer.tier, 3);
    assert.deepEqual(answer.data.map((item) => item.id), ["m1", "m2"]);
  } finally {
    await shop.close();
  }
});

test("tier 3 says what went wrong: the page stopped sending it, or went to sign in", async () => {
  const shop = await startApiShop();
  try {
    const contract = await learned(shop, "rest");
    const other = await recordRun(shop.origin, "graphql", "monitors");
    const drift = judgePageRun(contract, other);
    assert.equal(drift.class, "endpoint_drift");
    const login = judgePageRun(contract, { exchanges: [], final_url: `${shop.origin}/login?next=/search` });
    assert.equal(login.class, "auth");
    assert.equal(triggerFor({ ...contract, side_effect: "write" }, { q: "a1a" }).refused.class, "unavailable");
    assert.equal(triggerFor(contract, {}).refused.class, "input");
  } finally {
    await shop.close();
  }
});
