"""Model-free interactive smoke test. Requires a POSIX PTY and Pi on PATH."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

package = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(tempfile.mkdtemp(prefix="pi-memory-tui-"))
agent = root / "agent"
work = root / "work"
agent.mkdir()
work.mkdir()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
env = {**os.environ, "TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1"}
command = ["pi", "-ne", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", str(package), "-e", str(package / "verification" / "ui-provider.ts"), "--provider", "memory-ui-fixture", "--model", "local"]
process = subprocess.Popen(command, cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b""

def read_until(needle, seconds=15):
    global output
    deadline = time.monotonic() + seconds
    marker = len(output)
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.2)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            output += chunk
            # Answer terminal capability queries locally; never send a conversation prompt.
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
            if needle in output[marker:].decode("utf-8", "replace"):
                return
        if process.poll() is not None:
            break
    cleaned = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode("utf-8", "replace"))
    raise RuntimeError(f"Expected {needle!r}; terminal tail: {cleaned[-3000:]}")

def settle_input():
    # Wait for terminal output to quiesce before sending the next key sequence.
    # A border can be from the previous diff render, not proof that its Promise settled.
    global output
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.2)[0]:
            return
        output += os.read(master, 65536)

try:
    # Startup currently prints the version/banner; screen rendering then accepts commands.
    read_until("ctrl+c/ctrl+d")
    os.write(master, b"/codex-memory\r")
    read_until("Codex Memory v2")
    settle_input()
    os.write(master, b"\x03")
    settle_input()
    # A second command must work after cancelling the menu.
    os.write(master, b"/codex-memory status\r")
    read_until("generateMemories")
    settle_input()
    os.write(master, b"/reload\r")
    read_until("Reloaded")
    settle_input()
    os.write(master, b"/codex-memory\r")
    read_until("Codex Memory v2")
    os.write(master, b"\x1b")
    assert b"MODEL_REQUEST_FORBIDDEN_IN_UI_CHECK" not in output
    print(json.dumps({"status": "pass", "checks": ["TUI menu", "cancel", "status", "reload", "menu after reload"], "modelCalls": 0}))
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    os.close(master)
    shutil.rmtree(root)
