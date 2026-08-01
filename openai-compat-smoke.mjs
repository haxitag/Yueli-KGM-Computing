#!/usr/bin/env node
/**
 * Runs openai_compat_smoke and treats intentional post-success SIGKILL / macOS
 * native teardown aborts as pass when the smoke wrote the OK marker.
 * Lives at repo root so public sync (which strips scripts/) still works.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const marker = path.join(os.tmpdir(), "kgm-openai-compat-smoke.ok");

try {
  fs.unlinkSync(marker);
} catch {
  /* ignore */
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", path.join(root, "src/demo/openai_compat_smoke.ts")],
  { stdio: "inherit", cwd: root, env: process.env },
);

if (fs.existsSync(marker)) {
  try {
    fs.unlinkSync(marker);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.exit(result.status === null ? 1 : result.status);
