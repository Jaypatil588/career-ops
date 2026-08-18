#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const applierDir = resolve(root, "vendor/autoapply");
const venv = resolve(applierDir, ".venv");

for (const [command, args] of [
  ["git", ["submodule", "update", "--init", "--depth", "1", "vendor/autoapply"]],
  ["python3", ["-m", "venv", venv]],
  [resolve(venv, "bin/pip"), ["install", "-q", "-e", applierDir]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("AutoApply environment ready.");
