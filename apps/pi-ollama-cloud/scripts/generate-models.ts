#!/usr/bin/env tsx
import { runDirect } from "./cli/direct.ts";
import { runGeneration } from "./lib/generation/entry.ts";

runDirect(import.meta.url, () => runGeneration("catalog"));
