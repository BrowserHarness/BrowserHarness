#!/usr/bin/env node
// Copy the help guides from the knowledge base (knowledge/help/*.md) into the
// extension, so "Read the guide" works before the website exists.
// Usage: node scripts/sync-help.mjs ../browserharness-knowledgebase/knowledge/help
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.resolve(process.argv[2] || path.join(root, "../browserharness-knowledgebase/knowledge/help"));
const to = path.join(root, "apps/extension/src/help/articles");
if (!fs.existsSync(from)) {
  console.error(`No help guides at ${from}`);
  process.exit(2);
}
const guides = fs.readdirSync(from).filter((name) => /^[a-z0-9-]+\.md$/.test(name) && name !== "README.md");
fs.mkdirSync(to, { recursive: true });
for (const stale of fs.readdirSync(to).filter((name) => name.endsWith(".md") && !guides.includes(name))) {
  fs.rmSync(path.join(to, stale));
  console.log(`removed ${stale}`);
}
for (const name of guides) fs.copyFileSync(path.join(from, name), path.join(to, name));
console.log(`copied ${guides.length} guides from ${from}`);
