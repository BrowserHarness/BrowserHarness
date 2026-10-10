// API Recipe v2 learning from two runs and verification with an unseen
// third input, against the local fixture shop (no internet, no browser).
import assert from "node:assert/strict";
import test from "node:test";
import { startApiShop } from "./fixtures/api-shop.mjs";
import { recordRun } from "./fixtures/record-run.mjs";
import { learnApiOperation, proposeCandidates } from "../src/api-engine/learn.mjs";
import { verifyUnseenInput } from "../src/api-engine/verify.mjs";
import { callTier1 } from "../src/api-engine/tier1.mjs";
import { parseContract, classifySideEffect } from "../src/api-engine/recipe.mjs";
import { createApiEngine } from "../src/api-engine/service.mjs";

const EXAMPLES = [{ q: "laptops" }, { q: "keyboards" }];

async function learnFrom(shop, kind, options = {}) {
  const captures = [await recordRun(shop.origin, kind, "laptops", options), await recordRun(shop.origin, kind, "keyboards", options)];
  return { captures, learned: learnApiOperation({ name: "search", captures, examples: EXAMPLES, ...options.learn }) };
}

async function withShop(fn, state) {
  const shop = await startApiShop(state);
  try {
    await fn(shop);
  } finally {
    await shop.close();
  }
}

test("REST GET: two runs teach the query slot, a third input verifies it live", () =>
  withShop(async (shop) => {
    const { learned } = await learnFrom(shop, "rest");
    const contract = learned.contract;
    assert.equal(contract.contract_version, 2);
    assert.equal(contract.side_effect, "read");
    assert.equal(contract.request.method, "GET");
    assert.ok(contract.slots.some((slot) => slot.param === "q" && slot.at[0] === "query:q"));
    assert.equal(contract.response.extract, "items");
    assert.equal(contract.match.path, "/api/search");
    assert.equal(contract.verification.status, "unverified");
    assert.deepEqual(
      contract.verification.checks.map((check) => [check.kind, check.passed, check.item_count]),
      [
        ["learned_examples", true, 2],
        ["learned_examples", true, 2]
      ]
    );
    assert.equal(learned.evidence.run1.url, `${shop.origin}/api/search`);
    assert.equal(learned.example_fingerprints.length, 2);

    const before = shop.state.requests.length;
    const verified = await verifyUnseenInput(contract, { q: "monitors" }, { examples: EXAMPLES, example_fingerprints: learned.example_fingerprints, minIntervalMs: 0 });
    assert.equal(verified.check.passed, true, verified.check.detail);
    assert.equal(verified.contract.verification.status, "verified");
    assert.equal(verified.contract.transport.learned_tier, 1);
    assert.deepEqual(
      verified.response.data.map((item) => item.id),
      ["m1", "m2"]
    );
    // the answer came from a request sent now, with the new input
    const sent = shop.state.requests.slice(before);
    assert.equal(sent.length, 1);
    assert.match(sent[0].search, /q=monitors/);
  }));

test("GraphQL persisted query: the input is a nested variable, not the query hash", () =>
  withShop(async (shop) => {
    const { learned } = await learnFrom(shop, "graphql");
    const contract = learned.contract;
    assert.equal(contract.side_effect, "read");
    assert.match(contract.side_effect_basis, /GraphQL/);
    assert.ok(contract.slots.some((slot) => slot.param === "q" && slot.at.join(" ") === "body json:/variables/filter/term"));
    assert.equal(contract.response.extract, "data.search.products");
    assert.equal(contract.match.operationName, "SearchProducts");
    const verified = await verifyUnseenInput(contract, { q: "tablets" }, { examples: EXAMPLES, example_fingerprints: learned.example_fingerprints, minIntervalMs: 0 });
    assert.equal(verified.check.passed, true, verified.check.detail);
    assert.deepEqual(verified.response.data, [{ id: "t1", name: "Slate tablet", price: 329 }]);
  }));

test("form-encoded POST with JSON inside a field (f.req): the slot reaches into the nested JSON", () =>
  withShop(async (shop) => {
    const { learned } = await learnFrom(shop, "form");
    const contract = learned.contract;
    assert.ok(contract.slots.some((slot) => slot.param === "q" && slot.at.join(" ") === "form:f.req json:/query"));
    assert.equal(contract.side_effect, "read", contract.side_effect_basis);
    const verified = await verifyUnseenInput(contract, { q: "monitors" }, { examples: EXAMPLES, example_fingerprints: learned.example_fingerprints, minIntervalMs: 0 });
    assert.equal(verified.check.passed, true, verified.check.detail);
  }));

test("verification refuses a repeated example, an empty answer, and a recipe that ignores its input", () =>
  withShop(async (shop) => {
    const { learned } = await learnFrom(shop, "rest");
    const options = { examples: EXAMPLES, example_fingerprints: learned.example_fingerprints, minIntervalMs: 0 };

    const repeated = await verifyUnseenInput(learned.contract, { q: "Laptops" }, options);
    assert.equal(repeated.check.passed, false);
    assert.match(repeated.check.detail, /repeats a learning example/);
    assert.equal(repeated.contract.verification.status, "failed");

    const empty = await verifyUnseenInput(learned.contract, { q: "sofas" }, options);
    assert.equal(empty.check.passed, false);
    assert.match(empty.check.detail, /found nothing/);

    // a broken recipe whose input never reaches the request answers like run 1
    const deaf = parseContract({ ...learned.contract, slots: learned.contract.slots.filter((slot) => slot.at[0] !== "query:q") });
    const ignored = await verifyUnseenInput(deaf, { q: "monitors" }, options);
    assert.equal(ignored.check.passed, false);
    assert.match(ignored.check.detail, /equals a learning run's answer/);
  }));

test("credentials stay out of the contract: a storage token becomes a named reference", () =>
  withShop(async (shop) => {
    const token = "tok_9fK2mQ7vX1pL8sD4hJ6w";
    const storage = { authToken: token, theme: "dark" };
    const { learned } = await learnFrom(shop, "rest", {
      storage,
      cookies: [{ name: "sid", value: "valid-session-123456", domain: "127.0.0.1", path: "/" }],
      apiHeaders: { "x-auth-token": token }
    });
    const text = JSON.stringify(learned);
    assert.ok(!text.includes(token), "the token value is not kept");
    assert.ok(!text.includes("valid-session-123456"), "the cookie value is not kept");
    const contract = learned.contract;
    const source = contract.session_sources.find((item) => item.kind === "storage");
    assert.ok(source, JSON.stringify(contract.session_sources));
    assert.equal(source.key, "authToken");

    const noSession = await callTier1(contract, { q: "monitors" }, { minIntervalMs: 0 });
    assert.equal(noSession.ok, false);
    assert.equal(noSession.class, "auth");
    assert.doesNotMatch(noSession.reason, /tok_/);

    const before = shop.state.requests.length;
    const withSession = await callTier1(contract, { q: "monitors" }, { provided: { storage }, minIntervalMs: 0 });
    assert.equal(withSession.ok, true, withSession.reason);
    assert.equal(shop.state.requests.length, before + 1);
  }));

test("writes: never learned by running a trigger, never sent without approval", () =>
  withShop(async (shop) => {
    const captures = [await recordRun(shop.origin, "rest", "laptops"), await recordRun(shop.origin, "rest", "keyboards")];
    assert.throws(
      () => learnApiOperation({ name: "addThing", captures, examples: EXAMPLES, side_effect: "write", automated_trigger: true }),
      /API_LEARN_WRITE_REFUSED/
    );
    const { contract } = learnApiOperation({ name: "addThing", captures, examples: EXAMPLES, side_effect: "write" });
    assert.equal(contract.side_effect, "write");
    const verified = await verifyUnseenInput(contract, { q: "monitors" }, { examples: EXAMPLES, minIntervalMs: 0 });
    assert.equal(verified.check.passed, false);
    assert.match(verified.check.detail, /never sent to check it/);
    assert.equal(verified.contract.verification.status, "unverified");

    const before = shop.state.requests.length;
    const refused = await callTier1(contract, { q: "monitors" }, { minIntervalMs: 0 });
    assert.equal(refused.class, "approval_required");
    assert.equal(shop.state.requests.length, before, "nothing was sent");
  }));

test("side effects are judged from evidence, not the method alone", () => {
  const read = (method, url, body) => classifySideEffect({ method, url, ...(body ? { body } : {}) }).side_effect;
  assert.equal(read("GET", "https://x.test/api/search?q=a"), "read");
  assert.equal(read("GET", "https://x.test/api/cart/add?id=1"), "unknown");
  assert.equal(read("POST", "https://x.test/api/search"), "read");
  assert.equal(read("POST", "https://x.test/api/items"), "unknown");
  assert.equal(read("POST", "https://x.test/graphql", '{"query":"mutation Add { add }"}'), "write");
  assert.equal(read("POST", "https://x.test/graphql", '{"query":"query Find { find }"}'), "read");
  assert.equal(classifySideEffect({ method: "GET", url: "https://x.test/api/delete" }, { declared: "read" }).side_effect, "read");
});

test("one run learns with a warning; bad input is refused with candidates to choose from", () =>
  withShop(async (shop) => {
    const run = await recordRun(shop.origin, "rest", "laptops");
    const single = learnApiOperation({ name: "search", captures: [run], examples: [{ q: "laptops" }] });
    assert.match(single.warnings.join(" "), /learned from one run/);

    assert.throws(() => learnApiOperation({ name: "search", captures: [run, run], examples: [{ q: "laptops" }, { q: "laptops" }] }), /must differ/);
    assert.throws(() => learnApiOperation({ name: "bad name", captures: [run], examples: [{ q: "laptops" }] }), /API_LEARN_INPUT/);

    const candidates = proposeCandidates({ capture: run, example: { q: "laptops" } });
    assert.equal(candidates[0].url, `${shop.origin}/api/search`);
    assert.deepEqual(candidates[0].carries, ["q"]);
    assert.ok(!JSON.stringify(candidates).includes("laptops"), "candidate URLs carry no query");

    let error;
    try {
      learnApiOperation({ name: "search", captures: [run], examples: [{ q: "nowhere-term" }] });
    } catch (caught) {
      error = caught;
    }
    assert.match(error.message, /API_LEARN_FAILED/);
    assert.ok(Array.isArray(error.candidates));
  }));

test("the paired extension learns and verifies through api_request; other clients are refused", () =>
  withShop(async (shop) => {
    const { createBridgeServer, BRIDGE_PROTOCOL_VERSION } = await import("../src/core.mjs");
    const { WebSocket } = await import("ws");
    const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, token: "test-token", apiEngine: createApiEngine({ minIntervalMs: 0 }) });
    const { port } = await bridge.listen();
    const sockets = [];
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
      sockets.push(ws);
      await new Promise((resolve) => ws.once("open", resolve));
      return ws;
    };
    const next = (ws, predicate) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 20_000);
        ws.on("message", function onMessage(raw) {
          const message = JSON.parse(raw.toString());
          if (!predicate(message)) return;
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(message);
        });
      });
    try {
      const extension = await open();
      const ack = next(extension, (message) => message.type === "hello_ack");
      extension.send(JSON.stringify({ type: "hello", protocol_version: BRIDGE_PROTOCOL_VERSION, extension_id: "a".repeat(32) }));
      await ack;

      const captures = [await recordRun(shop.origin, "graphql", "laptops"), await recordRun(shop.origin, "graphql", "keyboards")];
      const learnedReply = next(extension, (message) => message.id === "learn");
      extension.send(
        JSON.stringify({ type: "api_request", id: "learn", action: "learn", payload: { name: "search", captures, examples: EXAMPLES, verify_args: { q: "monitors" } } })
      );
      const learned = await learnedReply;
      assert.equal(learned.type, "api_result");
      assert.equal(learned.ok, true, JSON.stringify(learned.error));
      assert.equal(learned.data.contract.verification.status, "verified");
      assert.equal(learned.data.verification.passed, true);

      const failReply = next(extension, (message) => message.id === "bad");
      extension.send(JSON.stringify({ type: "api_request", id: "bad", action: "learn", payload: { name: "search", captures: [], examples: [] } }));
      const failed = await failReply;
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, "API_LEARN_INPUT");

      const other = await open();
      const refusedReply = next(other, (message) => message.id === "x");
      other.send(JSON.stringify({ type: "api_request", id: "x", action: "status" }));
      const refused = await refusedReply;
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, "API_EXTENSION_REQUIRED");

      const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
      assert.equal(status.api_engine_enabled, true);
    } finally {
      for (const ws of sockets) ws.close();
      await bridge.close();
    }
  }));

test("taught inputs are kept for health checks and repair, unless an input is private", () =>
  withShop(async (shop) => {
    const { learned } = await learnFrom(shop, "rest");
    assert.deepEqual(learned.contract.provenance.example_inputs, { learning: EXAMPLES });
    const verified = await verifyUnseenInput(learned.contract, { q: "monitors" }, { examples: EXAMPLES, example_fingerprints: learned.example_fingerprints, minIntervalMs: 0 });
    assert.deepEqual(verified.contract.provenance.example_inputs, { learning: EXAMPLES, unseen: { q: "monitors" } });

    const { learned: hidden } = await learnFrom(shop, "rest", { learn: { private_params: ["q"] } });
    assert.equal(hidden.contract.provenance.example_inputs, undefined);
    assert.equal(hidden.contract.params[0].example, undefined);

    const { learned: repaired } = await learnFrom(shop, "rest", { learn: { source: "repair", parent_operation_id: "op-old" } });
    assert.equal(repaired.contract.provenance.source, "repair");
    assert.equal(repaired.contract.provenance.parent_operation_id, "op-old");
  }));
