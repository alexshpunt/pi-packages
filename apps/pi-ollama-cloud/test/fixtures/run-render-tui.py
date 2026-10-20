"""Exercise the actual Pi TUI expansion key and terminal resize using a private PTY."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument("--report", required=True)
args = parser.parse_args()
package = Path(__file__).resolve().parents[2]
node = shutil.which("node")
host = package / "node_modules/@earendil-works/pi-coding-agent"
manifest = json.loads((host / "package.json").read_text())
cli = host / manifest["bin"]["pi"]
report = {"result": "fail", "checks": [], "apiCallCounts": 0}
with tempfile.TemporaryDirectory(prefix="ollama-real-tui-") as directory:
    root = Path(directory)
    (root / "agent").mkdir()
    observation_path = root / "observations.json"
    env = {
        "PATH": os.environ["PATH"], "HOME": directory, "TMPDIR": directory,
        "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
        "PI_CODING_AGENT_DIR": str(root / "agent"), "PI_OFFLINE": "1",
        "OLLAMA_RENDER_OBSERVATIONS": str(observation_path),
    }
    subprocess.run([node, "--import", "tsx", "test/fixtures/render-session.ts", directory],
                   cwd=package, env=env, check=True, capture_output=True)
    session_path = (root / "session-path.txt").read_text()
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(directory)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 80, 0, 0))
        os.execve(node, [node, str(cli), "--no-skills", "--no-prompt-templates", "--no-themes",
                        "--no-context-files", "--session", session_path, "-e",
                        str(package / "test/fixtures/render-observer.ts")], env)
    output = bytearray()
    stopped = False

    def observations():
        try:
            return json.loads(observation_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {"observations": [], "errors": [], "networkCalls": 0}

    def wait_until(predicate):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
            state = observations()
            if state["errors"] or state["networkCalls"]:
                raise AssertionError("renderer fallback or network request observed")
            if predicate(state["observations"]):
                return
        raise AssertionError("TUI observation timeout")

    try:
        tools = {"ollama_web_search", "ollama_web_fetch"}
        wait_until(lambda rows: {r["tool"] for r in rows if not r["expanded"]} == tools)
        report["checks"].append("initial collapsed views for both tools")
        baseline_count = len(observations()["observations"])
        os.write(master, b"\x0f")  # Pi's app.tools.expand default (Ctrl+O)
        wait_until(lambda rows: {r["tool"] for r in rows[baseline_count:] if r["expanded"]} == tools)
        report["checks"].append("Ctrl+O expanded both registered renderers without fallback")
        baseline_count = len(observations()["observations"])
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 40, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        wait_until(lambda rows: any(r["width"] <= 40 for r in rows[baseline_count:]))
        report["checks"].append("terminal resized from 80 to 40 columns")
        baseline_count = len(observations()["observations"])
        os.write(master, b"\x0f")
        wait_until(lambda rows: {r["tool"] for r in rows[baseline_count:] if not r["expanded"]} == tools)
        report["checks"].append("Ctrl+O collapsed both renderers again")
        os.write(master, b"/quit\r")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                stopped = True
                assert os.waitstatus_to_exitcode(status) == 0
                break
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    pass
        assert stopped, "Pi did not shut down"
        assert (root / "agent/renderer-shutdown").exists()
        state = observations()
        assert not state["errors"] and state["networkCalls"] == 0
        report.update(result="pass", observedWidths=sorted({r["width"] for r in state["observations"]}),
                      piVersion=manifest["version"], terminalOutputBytes=len(output))
    except Exception as error:
        report["error"] = str(error)
    finally:
        if not stopped:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        os.close(master)
Path(args.report).parent.mkdir(parents=True, exist_ok=True)
Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
raise SystemExit(0 if report["result"] == "pass" else 1)
