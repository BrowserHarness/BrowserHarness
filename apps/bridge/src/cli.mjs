import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "./core.mjs";

const dir = path.join(os.homedir(), ".browsercrew-bridge");
const file = path.join(dir, "config.json");

async function loadConfig() {
  await mkdir(dir, { recursive: true });
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    const created = {
      host: "127.0.0.1",
      port: 10087,
      token: crypto.randomBytes(24).toString("hex")
    };
    await writeFile(file, JSON.stringify(created, null, 2) + "\n", {
      mode: 0o600
    });
    return created;
  }
}

const config = await loadConfig();
const bridge = createBridgeServer(config);
const address = await bridge.listen();

console.log(
  JSON.stringify({
    running: true,
    addr: `${config.host}:${address.port}`,
    ws: `ws://${config.host}:${address.port}/ws`,
    config: file,
    pairing_token: config.token
  })
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await bridge.close();
    process.exit(0);
  });
}
