#!/usr/bin/env node
// Standalone experiment: validate session-rebuild strategies for
// syncSharedSession's REBUILD path.
//
// Context: today, every "missed messages" rebuild creates a fresh session
// UUID, leaving the old session file orphaned and making debug logs harder
// to correlate across provider switches. We want to reuse the same sessionId
// across rebuilds. That requires Claude Code's `resume: sessionId` to read
// the JSONL fresh from disk each time, not cache by UUID.
//
// Tests:
//   1. clear+replace    — openSession + clear() + re-add + save. Baseline.
//   2. delete+recreate  — deleteSession() + createSession({sessionId}) + add + save.
//                         The approach we plan to adopt in syncSharedSession.
//   3. rebuild after CC tool use — CC's own query writes tool_use/tool_result
//                         records to the session file during execution. A
//                         subsequent rebuild must overwrite those cleanly
//                         without leaving orphan tool refs confusing CC.
//   4. companion dir    — CC creates sibling dirs (tool-results/, subagents/)
//                         during execution. Verify deleteSession wipes them so
//                         a reused UUID doesn't inherit stale artifacts.
//
// Run: node tests/exp-session-clear.mjs
// Needs ANTHROPIC_API_KEY or CC to be logged in.

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
// Use the local cc-session checkout (v0.2.0 has Session.clear() + deleteSession);
// node_modules has 0.1.2.
import { createSession, openSession, deleteSession } from "../../../cc-session/dist/index.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const CWD = process.cwd();
const MODEL = "claude-haiku-4-5";

let passed = 0;
let failed = 0;

function log(...a) { console.log("[exp]", ...a); }
function section(title) { console.log(`\n[exp] ==================== ${title} ====================`); }
function pass(msg) { passed++; log(`PASS: ${msg}`); }
function fail(msg) { failed++; log(`FAIL: ${msg}`); }

async function drain(q) {
  let out = "";
  for await (const m of q) {
    if (m.type === "assistant") {
      for (const block of m.message?.content ?? []) {
        if (block.type === "text") out += block.text;
      }
    }
  }
  return out.trim();
}

function seedTextSession(sid, token) {
  const s = createSession({
    sessionId: sid,
    projectPath: CWD,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
    model: MODEL,
  });
  s.addUserMessage(`Please remember: the token is ${token}.`);
  s.addAssistantMessage([{ type: "text", text: `Got it, the token is ${token}.` }]);
  s.save();
  return s;
}

function countRecords(jsonlPath) {
  if (!existsSync(jsonlPath)) return { total: 0, byType: {} };
  const content = readFileSync(jsonlPath, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  const byType = {};
  let toolUse = 0;
  let toolResult = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      byType[rec.type] = (byType[rec.type] || 0) + 1;
      if (rec.message?.content && Array.isArray(rec.message.content)) {
        for (const block of rec.message.content) {
          if (block.type === "tool_use") toolUse++;
          if (block.type === "tool_result") toolResult++;
        }
      }
    } catch { /* skip */ }
  }
  return { total: lines.length, byType, toolUse, toolResult };
}

async function askToken(sid, label) {
  const q = query({
    prompt: "What token did I ask you to remember? Reply with just the word.",
    options: { resume: sid, model: MODEL, cwd: CWD, permissionMode: "bypassPermissions" },
  });
  try {
    return await drain(q);
  } catch (e) {
    log(`  ${label} ERROR: ${e.message}`);
    return "";
  }
}

// ============================================================================
// TEST 1: clear + replace (baseline — previously validated)
// ============================================================================

async function test1() {
  section("TEST 1: openSession + clear + re-add + save");
  const sid = randomUUID();
  log(`sessionId=${sid}`);

  // Seed with FOO
  const s1 = seedTextSession(sid, "FOO");
  log(`seeded path=${s1.jsonlPath}`);

  // Resume and verify FOO
  const r1 = await askToken(sid, "query #1");
  log(`  response: ${r1}`);
  if (/foo/i.test(r1)) pass("seeded FOO resolved on first resume");
  else { fail("seeded FOO not returned"); return; }

  // clear + rewrite with BAR (same sessionId)
  const s2 = openSession({
    sessionId: sid,
    projectPath: CWD,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
  });
  log(`  openSession loaded ${s2.messages.length} messages from disk`);
  s2.clear();
  log(`  cleared. file exists=${existsSync(s2.jsonlPath)}`);
  s2.addUserMessage("Please remember: the token is BAR.");
  s2.addAssistantMessage([{ type: "text", text: "Got it, the token is BAR." }]);
  s2.save();

  // Resume and verify BAR
  const r2 = await askToken(sid, "query #2");
  log(`  response: ${r2}`);
  if (/bar/i.test(r2) && !/foo/i.test(r2)) pass("BAR returned after clear+replace, FOO gone");
  else if (/foo/i.test(r2)) fail("FOO still returned — CC cached by UUID");
  else fail("inconclusive — neither FOO nor BAR in response");
}

// ============================================================================
// TEST 2: deleteSession + createSession (the approach we plan to adopt)
// ============================================================================

async function test2() {
  section("TEST 2: deleteSession + createSession({sessionId}) + add + save");
  const sid = randomUUID();
  log(`sessionId=${sid}`);

  // Seed with ALPHA
  const s1 = seedTextSession(sid, "ALPHA");
  log(`seeded path=${s1.jsonlPath}`);

  // Resume and verify ALPHA
  const r1 = await askToken(sid, "query #1");
  log(`  response: ${r1}`);
  if (/alpha/i.test(r1)) pass("seeded ALPHA resolved on first resume");
  else { fail("ALPHA not returned"); return; }

  // Delete + recreate with BETA (same sessionId)
  deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
  log(`  deleteSession done. file exists=${existsSync(s1.jsonlPath)}`);
  const s2 = createSession({
    sessionId: sid,
    projectPath: CWD,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
    model: MODEL,
  });
  s2.addUserMessage("Please remember: the token is BETA.");
  s2.addAssistantMessage([{ type: "text", text: "Got it, the token is BETA." }]);
  s2.save();
  log(`  rewrote. exists=${existsSync(s2.jsonlPath)} size=${statSync(s2.jsonlPath).size}`);

  // Resume and verify BETA
  const r2 = await askToken(sid, "query #2");
  log(`  response: ${r2}`);
  if (/beta/i.test(r2) && !/alpha/i.test(r2)) pass("BETA returned, ALPHA gone, sessionId preserved");
  else if (/alpha/i.test(r2)) fail("ALPHA still returned — delete+recreate did not stick");
  else fail("inconclusive — neither ALPHA nor BETA in response");
}

// ============================================================================
// TEST 3: rebuild after CC has written tool_use records
// ============================================================================
//
// The concern: during a real turn, CC writes tool_use / tool_result records
// to the session file mid-execution. If a rebuild overwrites the file while
// leaving stale tool-use-id references in CC's internal state, the next
// query might fail with unresolved tool refs or orphaned message chains.
// We force a tool call by telling CC to Read a known file (package.json),
// then rebuild, then verify a subsequent resume resolves cleanly.

async function test3() {
  section("TEST 3: rebuild after CC writes tool_use records to disk");
  const sid = randomUUID();
  log(`sessionId=${sid}`);

  // Seed with GAMMA
  const s1 = seedTextSession(sid, "GAMMA");
  log(`seeded path=${s1.jsonlPath}`);

  const beforeToolUse = countRecords(s1.jsonlPath);
  log(`  before tool use: total=${beforeToolUse.total} toolUse=${beforeToolUse.toolUse} toolResult=${beforeToolUse.toolResult}`);

  // Ask CC to do a tool call (Read) so it writes tool_use records to the session file
  log("query: forcing a tool call via Read on package.json");
  const r1 = await drain(query({
    prompt: "Use the Read tool to read package.json and tell me the top-level name field (one word).",
    options: {
      resume: sid,
      model: MODEL,
      cwd: CWD,
      permissionMode: "bypassPermissions",
    },
  }));
  log(`  response: ${r1}`);

  const afterToolUse = countRecords(s1.jsonlPath);
  log(`  after tool use:  total=${afterToolUse.total} toolUse=${afterToolUse.toolUse} toolResult=${afterToolUse.toolResult} types=${JSON.stringify(afterToolUse.byType)}`);

  if (afterToolUse.toolUse === 0) {
    log("  WARNING: CC did not use a tool — test 3 not exercising the tool-record path");
  } else {
    pass(`CC wrote ${afterToolUse.toolUse} tool_use + ${afterToolUse.toolResult} tool_result block(s) to disk`);
  }

  // Rebuild the session (delete + recreate with preserved sessionId, new token DELTA)
  log("rebuilding session with fresh DELTA content (preserving sessionId)");
  deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
  const s2 = createSession({
    sessionId: sid,
    projectPath: CWD,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
    model: MODEL,
  });
  s2.addUserMessage("Please remember: the token is DELTA. Forget any previous tokens.");
  s2.addAssistantMessage([{ type: "text", text: "Got it, the token is DELTA." }]);
  s2.save();

  const afterRebuild = countRecords(s2.jsonlPath);
  log(`  after rebuild:   total=${afterRebuild.total} toolUse=${afterRebuild.toolUse} toolResult=${afterRebuild.toolResult}`);
  if (afterRebuild.total === 2 && afterRebuild.toolUse === 0 && afterRebuild.toolResult === 0) {
    pass("rebuild wrote only the 2 new records, tool records gone");
  } else {
    fail(`rebuild left unexpected records: ${JSON.stringify(afterRebuild)}`);
  }

  // Resume and verify DELTA — this is the key check. A bad rebuild would
  // leave CC confused about orphan tool refs and fail cleanly or hallucinate.
  const r2 = await askToken(sid, "query #2");
  log(`  response: ${r2}`);
  if (/delta/i.test(r2) && !/gamma/i.test(r2)) pass("DELTA returned cleanly after rebuild over tool-use records");
  else if (/gamma/i.test(r2)) fail("GAMMA still returned after rebuild");
  else fail(`inconclusive — response did not contain DELTA or GAMMA: ${r2}`);
}

// ============================================================================
// TEST 4: companion directory lifecycle
// ============================================================================
//
// CC creates a sibling directory `<sessionId>/` next to `<sessionId>.jsonl`
// during execution (holds subagents/, tool-results/ under v2.1.x). If we
// reuse a sessionId across rebuilds, we need deleteSession to wipe this dir
// so stale artifacts don't bleed through.

async function test4() {
  section("TEST 4: deleteSession wipes companion directory");
  const sid = randomUUID();
  log(`sessionId=${sid}`);

  const s1 = seedTextSession(sid, "EPSILON");
  const companionDir = s1.jsonlPath.replace(/\.jsonl$/, "");
  log(`  jsonl=${s1.jsonlPath}`);
  log(`  companion=${companionDir}`);

  // Simulate CC's runtime behavior by creating a sentinel file in the
  // companion dir (we don't need a real tool call — the file presence is
  // what matters for the cleanup check).
  mkdirSync(join(companionDir, "tool-results"), { recursive: true });
  const sentinel = join(companionDir, "tool-results", "sentinel.txt");
  writeFileSync(sentinel, "stale artifact from a previous rebuild");
  log(`  seeded sentinel at ${sentinel}`);

  if (!existsSync(sentinel)) {
    fail("could not seed sentinel — bailing");
    return;
  }

  // Rebuild via deleteSession — should wipe the companion dir
  deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);

  const jsonlGone = !existsSync(s1.jsonlPath);
  const sentinelGone = !existsSync(sentinel);
  const companionGone = !existsSync(companionDir);
  log(`  after deleteSession: jsonl gone=${jsonlGone} sentinel gone=${sentinelGone} companionDir gone=${companionGone}`);

  if (jsonlGone && sentinelGone && companionGone) {
    pass("deleteSession wiped jsonl + companion dir + sentinel");
  } else {
    fail(`deleteSession left artifacts: jsonl=${!jsonlGone} sentinel=${!sentinelGone} companionDir=${!companionGone}`);
  }
}

// ============================================================================
// Run
// ============================================================================

await test1();
await test2();
await test3();
await test4();

section("SUMMARY");
log(`passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
