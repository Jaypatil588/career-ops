#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const applierDir = resolve(root, "vendor/autoapply");
const python = resolve(applierDir, ".venv/bin/python");
const queue = resolve(root, "output/discovered-jobs.json");
const mode = process.argv[2] || "--check";

if (!new Set(["--check", "--run"]).has(mode) || process.argv.length !== 3) {
  console.error("Usage: node apply-discovered.mjs --check|--run");
  process.exit(2);
}
if (!existsSync(resolve(applierDir, "run.py"))) {
  console.error("AutoApply submodule is missing. Run: git submodule update --init");
  process.exit(2);
}
if (!existsSync(python)) {
  console.error("AutoApply environment is missing. Run: npm run apply:setup");
  process.exit(2);
}
if (!existsSync(queue)) {
  console.error("Discovery queue is missing. Run: npm run discover");
  process.exit(2);
}

const args = mode === "--check"
  ? ["-m", "bot.search.career_ops", queue]
  : ["run.py", "--gui", "--career-ops-queue", queue];
const result = spawnSync(python, args, {
  cwd: applierDir,
  env: { ...process.env, PYTHONUNBUFFERED: "1" },
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
