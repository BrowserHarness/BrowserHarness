// The native API engine's vendored modules load on the Node the Bridge runs
// on (engines >=20). Run under Node 20 as well as the packaged Node 22.
import assert from "node:assert/strict";
import test from "node:test";
import { nodeSupported, API_ANYTHING_MIN_NODE } from "../src/api-engine/upstream-adapter.mjs";

test("the running Node is supported and every engine module loads", async () => {
  assert.equal(nodeSupported(process.versions.node), true, `Node ${process.versions.node} < ${API_ANYTHING_MIN_NODE.join(".")}`);
  for (const file of ["recipe.mjs", "capture.mjs", "session.mjs", "outcome.mjs", "learn.mjs", "tier1.mjs", "verify.mjs", "service.mjs"]) {
    const loaded = await import(`../src/api-engine/${file}`);
    assert.ok(Object.keys(loaded).length > 0, file);
  }
  const { createApiEngine } = await import("../src/api-engine/service.mjs");
  const status = await createApiEngine().handle("status");
  assert.equal(status.contract_version, 2);
  assert.deepEqual(status.bridge_tiers, [1]);
});
