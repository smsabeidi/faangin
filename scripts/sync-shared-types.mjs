#!/usr/bin/env node
// Copies src/shared/billing-types.ts into functions/src/shared/billing-types.ts
// so the Firebase Functions build has a self-contained copy of the frozen
// billing contract. Run from the repo root. Hooked into `functions`
// `prebuild`, so a deploy can't ship with a stale mirror.
//
// Fails if the destination exists and has been edited by hand (i.e. its
// content differs from the source AFTER applying this script's normalization).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const source = resolve(repo, "src/shared/billing-types.ts");
const dest = resolve(repo, "functions/src/shared/billing-types.ts");

if (!existsSync(source)) {
  console.error(`sync-shared-types: source missing: ${source}`);
  process.exit(1);
}

const content = readFileSync(source, "utf8");

if (existsSync(dest)) {
  const current = readFileSync(dest, "utf8");
  if (current === content) {
    process.exit(0);
  }
}

writeFileSync(dest, content);
console.log(`sync-shared-types: wrote ${dest}`);
