// Regressions from the real-site acceptance of RC1 (4e79b41), each reproduced
// against the local fixture shop before its fix.
import assert from "node:assert/strict";
import test from "node:test";
import { startApiShop } from "./fixtures/api-shop.mjs";
import { recordRun } from "./fixtures/record-run.mjs";
import { learnApiOperation } from "../src/api-engine/learn.mjs";
import { judgePageRun } from "../src/api-engine/transport.mjs";
import { verifyUnseenInput } from "../src/api-engine/verify.mjs";
import { callTier1 } from "../src/api-engine/tier1.mjs";
import { buildForPage } from "../src/api-engine/transport.mjs";

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
    assert.equal(shop.state.requests.filter((item) => item.path === "/api/playlist/edit").length, 1, "learning sent nothing");
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

// RC2 review: tier 3 may set aside only headers that mirror the page's address
test("RC2 review: an independent header input must match too, not only the body or query", () =>
  withShop(async (shop) => {
    // q goes in the query; region goes only in a header the page sets
    const run = (q, region, extra = {}) => recordRun(shop.origin, "rest", q, { apiHeaders: { "x-region": region, ...extra } });
    const { contract } = learnApiOperation({
      name: "search",
      captures: [await run("laptops", "northeast"), await run("keyboards", "southwest")],
      examples: [{ q: "laptops", region: "northeast" }, { q: "keyboards", region: "southwest" }]
    });
    assert.ok(contract.slots.some((slot) => slot.param === "region" && slot.at[0] === "header:x-region"), JSON.stringify(contract.slots));
    const args = { q: "monitors", region: "midwest" };
    // query matches, the independent header does not: another request's data
    assert.equal(judgePageRun(contract, await run("monitors", "northeast"), args).ok, false, "a differing input header is rejected");
    // both match: accepted
    const both = judgePageRun(contract, await run("monitors", "midwest"), args);
    assert.equal(both.ok, true, both.reason);
    // two similar requests: the one carrying every input answers
    const wrong = await run("monitors", "northeast");
    const right = await run("monitors", "midwest");
    const mixed = { ...right, exchanges: [...right.exchanges, ...wrong.exchanges.map((item) => ({ ...item, id: item.id + 100 }))] };
    const picked = judgePageRun(contract, mixed, args);
    assert.equal(picked.ok, true, picked.reason);
    assert.equal(judgePageRun(contract, { ...right, exchanges: [...wrong.exchanges.map((item) => ({ ...item, id: item.id + 100 }))] }, args).ok, false);
  }));

test("RC2 review: a page-address header may differ when the other inputs match; wrong GraphQL variables are rejected", () =>
  withShop(async (shop) => {
    const run = (term, extra = "") => recordRun(shop.origin, "rest", term, { apiHeaders: { "x-site-url": `${shop.origin}/search?q=${encodeURIComponent(term)}${extra}` } });
    const { contract } = learnApiOperation({ name: "search", captures: [await run("laptops"), await run("keyboards")], examples: [{ q: "laptops" }, { q: "keyboards" }] });
    // GBIF case kept: the echo is written differently, the query decides
    assert.equal(judgePageRun(contract, await run("monitors", "&view=list"), { q: "monitors" }).ok, true);
    const gql = (term) => recordRun(shop.origin, "graphql", term);
    const graph = learnApiOperation({ name: "products", captures: [await gql("laptops"), await gql("keyboards")], examples: [{ term: "laptops" }, { term: "keyboards" }] }).contract;
    assert.equal(judgePageRun(graph, await gql("monitors"), { term: "monitors" }).ok, true);
    assert.equal(judgePageRun(graph, await gql("keyboards"), { term: "monitors" }).ok, false, "other variables are another request");
  }));

test("RC2 review: an input carried only by a page-address header is still checked (fail closed)", () =>
  withShop(async (shop) => {
    const run = (term, url = `${shop.origin}/search?q=${encodeURIComponent(term)}`) => recordRun(shop.origin, "rest", term, { apiHeaders: { "x-site-url": url } });
    const learned = learnApiOperation({ name: "search", captures: [await run("laptops"), await run("keyboards")], examples: [{ q: "laptops" }, { q: "keyboards" }] }).contract;
    // the same operation as if its only carrier of q were the echo header
    const contract = { ...learned, slots: learned.slots.filter((slot) => slot.at[0].startsWith("header:")) };
    assert.ok(contract.slots.length, JSON.stringify(learned.slots));
    assert.equal(judgePageRun(contract, await run("monitors", `${shop.origin}/search?q=monitors&sort=new`), { q: "monitors" }).ok, true);
    assert.equal(judgePageRun(contract, await run("monitors", `${shop.origin}/search?q=laptops`), { q: "monitors" }).ok, false, "an echo naming other inputs is rejected");
  }));

// RC2 review: a checkbox write names the item it acts on (YouTube Watch later's video id)
const VIDEO_A = "jNQXAC9IVRw";
const VIDEO_B = "dQw4w9WgXcQ";

test("RC2 review: a parameterless write is fixed to the item it was learned on, says so, and never takes another", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "save", VIDEO_A, { cookies: [VISITOR] })];
    const { contract } = learnApiOperation({ name: "watch_later", captures, examples: [{}], side_effect: "write", pick_request: `POST ${shop.origin}/api/playlist/edit` });
    assert.deepEqual(contract.params, []);
    assert.equal(contract.target?.kind, "fixed", JSON.stringify(contract.target));
    assert.equal(contract.target.request, `POST ${shop.origin}/api/playlist/edit`);
    assert.ok(contract.target.fields.some((field) => field.value === VIDEO_A && /addedVideoId/.test(field.at)), JSON.stringify(contract.target));
    assert.ok(!JSON.stringify(contract).includes("Vx9kQ2mLp7Rt"), "no visitor id in the Skill");

    const writes = () => shop.state.requests.filter((item) => item.path === "/api/playlist/edit");
    const before = writes().length;
    // asked to act on video B (the page the person is on now): refused, nothing sent
    for (const args of [{ video: VIDEO_B }, { videoId: VIDEO_B }]) {
      const tier1 = await callTier1(contract, args, { approved: true, minIntervalMs: 0 });
      assert.equal(tier1.ok, false);
      assert.equal(tier1.class, "input");
      assert.equal(tier1.sent, false);
      assert.match(tier1.reason, new RegExp(VIDEO_A));
      assert.equal(buildForPage(contract, args, { approved: true }).refused?.class, "input");
    }
    assert.equal(writes().length, before, "nothing was sent for video B");
    // run as learned: it acts on A, and only once
    const ran = await callTier1(contract, {}, { approved: true, minIntervalMs: 0 });
    assert.equal(ran.sent, true);
    assert.equal(writes().length, before + 1);
    assert.match(writes().at(-1).body, new RegExp(VIDEO_A));
    assert.doesNotMatch(writes().at(-1).body, new RegExp(VIDEO_B));
  }));

test("RC2 review: a write whose target was never recorded is refused before sending", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "save", VIDEO_A, { cookies: [VISITOR] })];
    const { contract } = learnApiOperation({ name: "watch_later", captures, examples: [{}], side_effect: "write", pick_request: `POST ${shop.origin}/api/playlist/edit` });
    const legacy = { ...contract };
    delete legacy.target;
    const before = shop.state.requests.length;
    const tier1 = await callTier1(legacy, {}, { approved: true, minIntervalMs: 0 });
    assert.equal(tier1.ok, false);
    assert.equal(tier1.sent, false);
    assert.match(tier1.reason, /target/);
    assert.equal(buildForPage(legacy, {}, { approved: true }).refused?.class, "input");
    assert.equal(shop.state.requests.length, before);
  }));

test("RC2 review: a dynamic target is bound to an explicit parameter and only acts on the value given", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "save", VIDEO_A, { cookies: [VISITOR] })];
    const { contract } = learnApiOperation({ name: "watch_later", captures, examples: [{ video: VIDEO_A }], side_effect: "write", pick_request: `POST ${shop.origin}/api/playlist/edit` });
    assert.equal(contract.target?.kind, "parameter");
    assert.deepEqual(contract.target.params, ["video"]);
    assert.ok(!JSON.stringify(contract).includes(VIDEO_A), "the demonstrated video is not kept");
    assert.ok(!JSON.stringify(contract).includes("Vx9kQ2mLp7Rt"));
    const writes = () => shop.state.requests.filter((item) => item.path === "/api/playlist/edit");
    const before = writes().length;
    const missing = await callTier1(contract, {}, { approved: true, minIntervalMs: 0 });
    assert.equal(missing.sent, false);
    assert.equal(writes().length, before, "no video given: nothing sent");
    const ran = await callTier1(contract, { video: VIDEO_B }, { approved: true, minIntervalMs: 0 });
    assert.equal(ran.sent, true);
    assert.match(writes().at(-1).body, new RegExp(VIDEO_B));
    assert.doesNotMatch(writes().at(-1).body, new RegExp(VIDEO_A));
  }));
