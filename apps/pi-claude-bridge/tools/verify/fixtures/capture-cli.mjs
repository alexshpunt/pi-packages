#!/usr/bin/env node
// Intentionally not Claude Code: no network, auth, tools, or SDK control handshake.
import { writeFileSync } from "node:fs";
const keys = JSON.parse(process.env.BRIDGE_VERIFY_ENV_KEYS ?? "[]");
writeFileSync(process.env.BRIDGE_VERIFY_CAPTURE, JSON.stringify({
	argv: process.argv.slice(2),
	env: Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
}), { mode: 0o600 });
process.exit(0);
