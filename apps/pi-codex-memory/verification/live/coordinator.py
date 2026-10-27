"""Real-model check of closed-session coordination across several Pi processes.

Runs real Pi TUI processes in one temporary folder with the repository's claude-bridge provider and
claude-haiku-5-5. Requires Pi on PATH, a Claude Code login and a build of this package. About fifteen
model requests count against the Claude subscription. Prints a JSON report; exits 1 on a failed check.
"""
import fcntl
import json
import os
import pathlib
import pty
import re
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

PACKAGE = pathlib.Path(__file__).resolve().parents[2]
BRIDGE = PACKAGE.parents[1] / "apps" / "pi-claude-bridge"
MODEL = {"provider": "claude-bridge", "id": "claude-haiku-5-5"}
ROOT = pathlib.Path(tempfile.mkdtemp(prefix="pi-memory-live-"))
AGENT = ROOT / "agent"
AGENT.mkdir()
(ROOT / "work").mkdir()
WORK = pathlib.Path(os.path.realpath(ROOT / "work"))
STORE = AGENT / "pi-codex-memory"
(AGENT / "claude-bridge.json").write_text(json.dumps({"startupNoticeShown": "2026-01-01"}))
ENV = {**os.environ, "TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(AGENT)}
for key in ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
    ENV.pop(key, None)
STARTED = time.monotonic()
checks = []
events = []


def elapsed():
    return round(time.monotonic() - STARTED, 1)


def note(event, **fields):
    events.append({"t": elapsed(), "event": event, **fields})


def check(name, ok, **detail):
    checks.append({"name": name, "ok": bool(ok), "t": elapsed(), **detail})
    if not ok:
        raise AssertionError(f"{name}: {detail}")


def now_ms():
    return int(time.time() * 1000)


def query(sql, *args):
    path = STORE / "state.sqlite"
    if not path.exists():
        return []
    for _ in range(100):
        try:
            database = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
            try:
                database.row_factory = sqlite3.Row
                return [dict(row) for row in database.execute(sql, args)]
            finally:
                database.close()
        except sqlite3.OperationalError as error:
            if "no such table" in str(error):
                return []
            time.sleep(0.1)
    raise RuntimeError(f"database stayed locked: {sql}")


def save_settings(**changes):
    script = """
const [{ MemoryStore }, { DEFAULT_SETTINGS }] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);
const store = new MemoryStore(process.argv[3]);
const scope = store.scopeFor(process.argv[4]);
store.saveSettings(scope, { ...DEFAULT_SETTINGS, ...store.getSettings(scope), ...JSON.parse(process.argv[5]) });
store.close();
"""
    subprocess.run(
        ["node", "--input-type=module", "-e", script, (PACKAGE / "dist/store.js").as_uri(), (PACKAGE / "dist/config.js").as_uri(), str(STORE), str(WORK), json.dumps(changes)],
        check=True,
    )
    note("settings", **{key: value for key, value in changes.items() if not key.endswith("Model")})


def wait(condition, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError(f"timed out after {seconds}s waiting for {what}")


def open_sessions():
    return {row["session_id"]: row["owner"] for row in query("SELECT session_id, owner FROM activity WHERE expires_at > ?", now_ms())}


def leader():
    rows = query("SELECT owner FROM coordinators WHERE lease_until > ?", now_ms())
    return rows[0]["owner"] if rows else None


def job(session_id):
    rows = query("SELECT status, attempts, error FROM jobs WHERE key = ?", f"extract:{session_id}")
    return rows[0] if rows else None


def session_file(session_id):
    files = list((AGENT / "sessions").glob(f"*/*_{session_id}.jsonl"))
    return files[0] if files else None


def replies(session_id):
    path = session_file(session_id)
    if not path:
        return []
    texts = []
    for line in path.read_text().splitlines():
        entry = json.loads(line)
        message = entry.get("message") or {}
        if entry.get("type") == "message" and message.get("role") == "assistant" and message.get("stopReason") == "stop":
            texts.append("".join(part.get("text", "") for part in message.get("content", []) if part.get("type") == "text"))
    return texts


class Pi:
    """One real Pi TUI process in a PTY; output is drained on a thread so Pi never blocks."""

    def __init__(self, name):
        self.name = name
        self.session_id = None
        self.output = bytearray()
        self.lock = threading.Lock()
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
        command = ["pi", "-ne", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", str(PACKAGE), "-e", str(BRIDGE), "--provider", MODEL["provider"], "--model", MODEL["id"]]
        self.process = subprocess.Popen(command, cwd=WORK, env=ENV, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.master = master
        threading.Thread(target=self._drain, daemon=True).start()
        wait(lambda: b"ctrl+c/ctrl+d" in self.snapshot(), 60, f"{name} to start")
        time.sleep(2)
        note("started", process=name)

    def _drain(self):
        while True:
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return
            if not chunk:
                return
            with self.lock:
                self.output += chunk
            if b"\x1b[6n" in chunk:
                try:
                    os.write(self.master, b"\x1b[1;1R")
                except OSError:
                    return

    def snapshot(self):
        with self.lock:
            return bytes(self.output)

    def tail(self):
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07", "", self.snapshot().decode("utf-8", "replace"))
        return text[-1500:]

    def claim_session(self, known, seconds=20):
        self.session_id = wait(lambda: next((sid for sid in open_sessions() if sid not in known), None), seconds, f"{self.name} heartbeat")
        note("session", process=self.name, session=self.session_id)
        return self.session_id

    def ask(self, prompt):
        before = len(replies(self.session_id))
        os.write(self.master, prompt.encode() + b"\r")
        text = wait(lambda: (lambda found: found[before] if len(found) > before else None)(replies(self.session_id)), 180, f"{self.name} answer")
        note("answered", process=self.name)
        return text

    def quit(self):
        os.write(self.master, b"/quit\r")
        self.process.wait(timeout=30)
        note("quit", process=self.name)

    def kill(self):
        os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=10)
        note("killed", process=self.name)

    def close(self):
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=10)
        os.close(self.master)


processes = []
status = "fail"
error = None
try:
    # Memory off: an open session records nothing.
    p0 = Pi("p0")
    processes.append(p0)
    time.sleep(4)
    check("memory off records no open session or coordinator", not query("SELECT * FROM activity") and not query("SELECT * FROM coordinators"))

    # Memory on from outside the process: its next tick, at most 30 seconds later, marks it open and
    # it starts coordinating. The coordinator's 90-second wait covers that delay.
    save_settings(useMemories=True, generateMemories=True, extractModel=MODEL, consolidateModel=MODEL, minIdleMs=60_000, consolidationCooldownMs=60_000, pollIntervalMs=1000)
    p0.claim_session(set(), seconds=45)
    wait(leader, 10, "a coordinator")
    check("turning memory on starts the heartbeat and one coordinator", len(query("SELECT * FROM coordinators")) == 1 and leader() == open_sessions()[p0.session_id])

    # p1 has a conversation and quits; its heartbeat is removed at shutdown.
    p1 = Pi("p1")
    processes.append(p1)
    p1.claim_session({p0.session_id})
    p1.ask("For project Zephyr we decided the release gate is amber. Reply with OK only.")
    p1.quit()
    check("quitting removes the session's heartbeat", p1.session_id not in open_sessions())

    # p2 has a conversation and stays open; p3 only keeps a session open.
    p2 = Pi("p2")
    processes.append(p2)
    p2.claim_session({p0.session_id})
    p2.ask("For project Zephyr the staging database is named blue-7. Reply with OK only.")
    p2_answered_at = time.monotonic()
    p3 = Pi("p3")
    processes.append(p3)
    p3.claim_session({p0.session_id, p2.session_id})

    wait(lambda: (job(p1.session_id) or {}).get("status") == "succeeded", 360, "p1 extraction")
    wait(lambda: query("SELECT summary FROM scopes WHERE summary != ''"), 120, "first summary")
    first = job(p1.session_id)
    check("the closed conversation became memory once", first["attempts"] == 1, job=first)
    # Give the coordinator several scans after p2 has been idle longer than the 60-second wait.
    remaining = 60 + 15 - (time.monotonic() - p2_answered_at)
    if remaining > 0:
        time.sleep(remaining)
    check("an open conversation idle past the wait is not turned into memory", job(p2.session_id) is None, job=job(p2.session_id))

    # The coordinating process is killed; another takes over when its lease lapses.
    owners = open_sessions()
    killed_owner = leader()
    victim = next(process for process in processes if process.process.poll() is None and owners.get(process.session_id) == killed_owner)
    victim.kill()
    new_leader = wait(lambda: (lambda owner: owner if owner and owner != killed_owner else None)(leader()), 150, "a new coordinator")
    check("another session takes over a killed coordinator", new_leader != killed_owner, killed=victim.name)
    if victim is not p2:
        p2.quit()
    wait(lambda: (job(p2.session_id) or {}).get("status") == "succeeded", 360, "p2 extraction")
    second = job(p2.session_id)
    check("the conversation closed second became memory once", second["attempts"] == 1, job=second, closedBy="kill" if victim is p2 else "quit")
    wait(lambda: query("SELECT 1 FROM scopes WHERE summary LIKE ?", f"%{p2.session_id}%"), 180, "summary with p2")
    calls = sum(row["calls"] for row in query("SELECT calls FROM usage"))
    check("memory model calls: two extractions and two summaries", calls == 4, calls=calls)

    # Create memories now: a conversation closed seconds ago becomes memory without the wait, the
    # summary updates despite its interval, and another session's status line shows the job.
    p4 = Pi("p4")
    processes.append(p4)
    p4.claim_session({process.session_id for process in processes if process.session_id})
    p5 = Pi("p5")
    processes.append(p5)
    p5.claim_session({process.session_id for process in processes if process.session_id})
    p5.ask("For project Zephyr the on-call channel is zephyr-ops. Reply with OK only.")
    p5.quit()
    closed_at = time.monotonic()
    status_mark = len(p4.snapshot())
    os.write(p3.master, b"/codex-memory\r")
    wait(lambda: b"Create memories now" in p3.snapshot(), 15, "the Create memories now row")
    time.sleep(1)
    # Create memories now is the sixth row, after Saved memories.
    os.write(p3.master, b"\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r")
    wait(lambda: b"All closed conversations" in p3.snapshot(), 15, "the creation range selector")
    time.sleep(1)
    os.write(p3.master, b"\r")  # Keep the preselected configured recent period.
    wait(lambda: (job(p5.session_id) or {}).get("status") == "succeeded", 120, "p5 extraction")
    manual_seconds = round(time.monotonic() - closed_at, 1)
    wait(lambda: query("SELECT 1 FROM scopes WHERE summary LIKE ?", f"%{p5.session_id}%"), 120, "summary with p5")
    check("Create memories now does not wait for the idle time", manual_seconds < 60, seconds=manual_seconds, job=job(p5.session_id))
    wait(lambda: "Created memories from 1 conversation(s)." in p3.tail(), 30, "the result notice")
    seen = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", p4.snapshot()[status_mark:].decode("utf-8", "replace"))
    check("another session's status line showed the job", "creating 1 memory…" in seen)

    # A new session uses the memory made in the background and by hand.
    answer = p4.ask("Using memory, what release gate, staging database name and on-call channel were decided for project Zephyr? Answer in one short line.")
    check("a session recalls all three facts", all(fact in answer.lower() for fact in ("amber", "blue-7", "zephyr-ops")), answer=answer[:300])

    # Memory off again: every open session drops its heartbeat and the coordinator lease is released.
    save_settings(useMemories=False, generateMemories=False)
    wait(lambda: not query("SELECT * FROM activity") and not query("SELECT * FROM coordinators"), 10, "heartbeats and lease removed")
    check("turning memory off removes every heartbeat and the lease", True)
    status = "pass"
except Exception as failure:  # noqa: BLE001 - the report records any failure
    error = str(failure)
finally:
    tails = {process.name: process.tail() for process in processes} if status != "pass" else {}
    for process in processes:
        process.close()
    usage = query("SELECT day, calls, input_tokens, output_tokens FROM usage")
    jobs = query("SELECT key, status, attempts, error FROM jobs ORDER BY key")
    print(json.dumps({"status": status, "error": error, "seconds": elapsed(), "checks": checks, "events": events, "jobs": jobs, "usage": usage, "tails": tails}, ensure_ascii=False, indent=2))
    shutil.rmtree(ROOT, ignore_errors=True)
    sys.exit(0 if status == "pass" else 1)
