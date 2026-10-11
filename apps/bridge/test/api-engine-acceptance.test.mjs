// Regressions from the real-site acceptance of RC1 (4e79b41), each reproduced
// against the local fixture shop before its fix.
import assert from "node:assert/strict";
import test from "node:test";
import { startApiShop } from "./fixtures/api-shop.mjs";
import { recordRun } from "./fixtures/record-run.mjs";
import { learnApiOperation } from "../src/api-engine/learn.mjs";
import { judgePageRun } from "../src/api-engine/transport.mjs";
import { verifyUnseenInput } from "../src/api-engine/verify.mjs";

async function withShop(fn, state) {
  const shop = await startApiShop(state);
  try {
    await fn(shop);
  } finally {
    await shop.close();
  }
}

test("F1: a tracking cookie whose value is the site's own domain does not block learning", () =>
  withShop(async (shop) => {
    // Coursera's IR_gbd and Meetup's _li_dcdm_c hold the site's domain, so the
    // page address in referer/origin "contains" them; they are not credentials
    const host = new URL(shop.origin).hostname;
    const cookies = [
      { name: "IR_gbd", value: host, domain: host, path: "/", expires: -1, httpOnly: false, secure: false },
      { name: "_li_dcdm_c", value: `.${host}`, domain: host, path: "/", expires: -1, httpOnly: false, secure: false },
      { name: "sid", value: "s3cr3t-session-0123456789abcdef", domain: host, path: "/", expires: -1, httpOnly: true, secure: false }
    ];
    const captures = [await recordRun(shop.origin, "graphql", "laptops", { cookies }), await recordRun(shop.origin, "graphql", "keyboards", { cookies })];
    const { contract } = learnApiOperation({ name: "search", captures, examples: [{ term: "laptops" }, { term: "keyboards" }] });
    assert.equal(contract.request.method, "POST");
    // the real session cookie is still never kept
    assert.ok(!JSON.stringify(contract).includes("s3cr3t-session"));
  }));

test("F2: tier 3 matches the request by its inputs, not by a header that echoes the page address", () =>
  withShop(async (shop) => {
    // GBIF sends x-gbif-site-url (the page's address) beside its GraphQL
    // variables; the SPA's address need not be the trigger URL character for character
    const run = (term, extra = "") =>
      recordRun(shop.origin, "rest", term, { apiHeaders: { "x-site-url": `${shop.origin}/search?q=${encodeURIComponent(term)}${extra}` } });
    const { contract } = learnApiOperation({ name: "search", captures: [await run("laptops"), await run("keyboards")], examples: [{ q: "laptops" }, { q: "keyboards" }] });
    assert.ok(contract.slots.some((slot) => slot.at[0] === "header:x-site-url"), "the echo header is a templated slot");
    const later = await run("monitors", "&sort=relevance");
    const answer = judgePageRun(contract, later, { q: "monitors" });
    assert.equal(answer.ok, true, answer.reason);
    // a request for other inputs is still refused
    assert.equal(judgePageRun(contract, await run("laptops", "&sort=relevance"), { q: "monitors" }).ok, false);
  }));

test("F2: when several requests rank equally, learning takes the page's last one (the submitted search, not a keystroke's)", () =>
  withShop(async (shop) => {
    // YouTube's per-keystroke autocomplete and GBIF's first default query both
    // carry the input as well as the real request; the real one comes last
    const doubled = async (term) => {
      const base = await recordRun(shop.origin, "rest", term);
      const api = base.exchanges.find((item) => item.request.url.includes("/api/search"));
      const early = { ...api, id: 3, request: { ...api.request, url: `${shop.origin}/api/suggest?q=${encodeURIComponent(term)}&page=1&lang=en` } };
      return { ...base, exchanges: [...base.exchanges.filter((item) => item !== api), early, { ...api, id: 4 }] };
    };
    const { contract, warnings } = learnApiOperation({ name: "search", captures: [await doubled("laptops"), await doubled("keyboards")], examples: [{ q: "laptops" }, { q: "keyboards" }] });
    assert.equal(contract.match.path, "/api/search", JSON.stringify(warnings));
  }));

const SIGNED_IN = [{ name: "sid", value: "valid-session-123456", domain: "127.0.0.1", path: "/" }];
const VISITOR = { name: "VISITOR_INFO1_LIVE", value: "Vx9kQ2mLp7Rt", domain: "127.0.0.1", path: "/" };

function refused(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected learning to refuse");
}

test("F9: a refusal lists the captured requests (no values) and pick_request learns the one chosen", () =>
  withShop(async (shop) => {
    // YouTube: the video id is in get_panel (sent with the visitor id) and in edit_playlist
    const captures = [await recordRun(shop.origin, "save", "jNQXAC9IVRw", { cookies: [VISITOR] })];
    const first = refused(() => learnApiOperation({ name: "save", captures, examples: [{ video: "jNQXAC9IVRw" }], side_effect: "write" }));
    assert.match(first.code, /^API_LEARN_/);
    assert.doesNotMatch(first.message, /--from|--pick-request|--html|--embedded/, "no upstream command-line hints");
    assert.ok(Array.isArray(first.candidates) && first.candidates.length >= 2, first.message);
    const edit = first.candidates.find((item) => item.request === `POST ${shop.origin}/api/playlist/edit`);
    assert.ok(edit, JSON.stringify(first.candidates));
    assert.ok(!JSON.stringify(first.candidates).includes("Vx9kQ2mLp7Rt"), "candidates carry no values");
    assert.ok(!JSON.stringify(first.candidates).includes("jNQXAC9IVRw"), "candidates carry no inputs");

    // choose it by the request (stable across runs) or by its id in this capture
    for (const pick of [edit.request, edit.id]) {
      const { contract } = learnApiOperation({ name: "save", captures, examples: [{ video: "jNQXAC9IVRw" }], side_effect: "write", pick_request: pick });
      assert.equal(contract.match.path, "/api/playlist/edit");
      assert.equal(contract.side_effect, "write");
      assert.ok(!JSON.stringify(contract).includes("Vx9kQ2mLp7Rt"));
    }

    // the visitor id stays protected: choosing the panel request is still refused
    const panel = refused(() => learnApiOperation({ name: "save", captures, examples: [{ video: "jNQXAC9IVRw" }], side_effect: "write", pick_request: `POST ${shop.origin}/api/panel` }));
    assert.match(panel.code, /^API_LEARN_/);
    // a request that was not captured is named as such
    assert.match(refused(() => learnApiOperation({ name: "save", captures, examples: [{ video: "jNQXAC9IVRw" }], side_effect: "write", pick_request: `POST ${shop.origin}/api/nope` })).message, /no captured request/);
  }));

test("F6: a checkbox write with no typed input is learned from the request a person picks", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "save", "jNQXAC9IVRw", { cookies: [VISITOR] })];
    // without a pick there is nothing to tell the requests apart: refuse and list them
    const unpicked = refused(() => learnApiOperation({ name: "watch_later", captures, examples: [{}], side_effect: "write" }));
    assert.equal(unpicked.code, "API_LEARN_PICK_REQUEST");
    assert.ok(unpicked.candidates.some((item) => item.request === `POST ${shop.origin}/api/playlist/edit`));
    assert.ok(!unpicked.candidates.some((item) => /config/.test(item.request) && item.method !== "GET"));
    const { contract } = learnApiOperation({ name: "watch_later", captures, examples: [{}], side_effect: "write", pick_request: `POST ${shop.origin}/api/playlist/edit` });
    assert.equal(contract.side_effect, "write");
    assert.deepEqual(contract.params, []);
    assert.notEqual(contract.verification.status, "verified");
    assert.equal(shop.state.writes, 1, "learning sent nothing");
  }));

test("F6: a signed-in list with no input is learned from two runs and a picked request", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "my-orders", "", { cookies: SIGNED_IN }), await recordRun(shop.origin, "my-orders", "", { cookies: SIGNED_IN })];
    const unpicked = refused(() => learnApiOperation({ name: "orders", captures, examples: [{}, {}] }));
    assert.equal(unpicked.code, "API_LEARN_PICK_REQUEST");
    const { contract } = learnApiOperation({ name: "orders", captures, examples: [{}, {}], pick_request: `GET ${shop.origin}/api/my-orders` });
    assert.equal(contract.match.path, "/api/my-orders");
    assert.equal(contract.side_effect, "read");
    assert.equal(contract.learned_logged_in, true);
    assert.equal(contract.verification.status, "unverified", JSON.stringify(contract.verification));
    assert.ok(!JSON.stringify(contract).includes("valid-session-123456"));
  }));

test("F3: a page document is never counted as verified data", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "history", "laptops", { cookies: SIGNED_IN }), await recordRun(shop.origin, "history", "keyboards", { cookies: SIGNED_IN })];
    let outcome;
    try {
      outcome = learnApiOperation({ name: "history", captures, examples: [{ q: "laptops" }, { q: "keyboards" }] });
    } catch (error) {
      outcome = { error };
    }
    if (outcome.contract) {
      assert.equal(outcome.contract.verification.status, "failed", "the learned examples check must not pass on a whole page");
      assert.match(JSON.stringify(outcome.contract.verification.checks), /page|HTML/i);
    } else {
      assert.match(outcome.error.code, /^API_LEARN_/);
    }
  }));

test("F5: an anonymous framework session cookie is not a sign-in", () =>
  withShop(async (shop) => {
    const anonymous = [
      { name: "laravel_session", value: "eyJpdiI6IkFub255bW91cyJ9abcdef", domain: "127.0.0.1", path: "/" },
      { name: "XSRF-TOKEN", value: "eyJpdiI6IlhTUkYifQabcdef", domain: "127.0.0.1", path: "/" }
    ];
    const captures = [await recordRun(shop.origin, "rest", "laptops", { cookies: anonymous }), await recordRun(shop.origin, "rest", "keyboards", { cookies: anonymous })];
    const { contract } = learnApiOperation({ name: "search", captures, examples: [{ q: "laptops" }, { q: "keyboards" }] });
    assert.equal(contract.learned_logged_in, false);
    const signed = [await recordRun(shop.origin, "orders", "laptops", { cookies: SIGNED_IN }), await recordRun(shop.origin, "orders", "keyboards", { cookies: SIGNED_IN })];
    assert.equal(learnApiOperation({ name: "orders", captures: signed, examples: [{ q: "laptops" }, { q: "keyboards" }] }).contract.learned_logged_in, true);
  }));

test("F6: a no-input read verifies only on a live answer with real data, and signed out it is auth", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "my-orders", "", { cookies: SIGNED_IN }), await recordRun(shop.origin, "my-orders", "", { cookies: SIGNED_IN })];
    const { contract, example_fingerprints } = learnApiOperation({ name: "orders", captures, examples: [{}, {}], pick_request: `GET ${shop.origin}/api/my-orders` });
    const live = await verifyUnseenInput(contract, {}, { examples: [{}, {}], example_fingerprints, provided: { cookies: SIGNED_IN, storage: {} }, minIntervalMs: 0 });
    assert.equal(live.check.passed, true, live.check.detail);
    assert.equal(live.contract.verification.status, "verified");
    const signedOut = await verifyUnseenInput(contract, {}, { examples: [{}, {}], example_fingerprints, provided: { cookies: [], storage: {} }, minIntervalMs: 0 });
    assert.equal(signedOut.check.passed, false);
    assert.equal(signedOut.check.class, "auth");
  }));

test("F3: a whole-page answer never passes the live check either", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "history", "laptops", { cookies: SIGNED_IN }), await recordRun(shop.origin, "history", "keyboards", { cookies: SIGNED_IN })];
    let learned;
    try {
      learned = learnApiOperation({ name: "history", captures, examples: [{ q: "laptops" }, { q: "keyboards" }] });
    } catch {
      return;
    }
    const live = await verifyUnseenInput(learned.contract, { q: "monitors" }, { examples: [{ q: "laptops" }, { q: "keyboards" }], provided: { cookies: SIGNED_IN, storage: {} }, minIntervalMs: 0 });
    assert.equal(live.check.passed, false);
    assert.notEqual(live.contract.verification.status, "verified");
  }));
