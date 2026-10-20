#!/usr/bin/env python3
"""PTY bridge for host-contract verification.

Runs one command in a PTY it owns, forwarding stdin bytes to the PTY input and PTY output to stdout unchanged.
When the child ends, it drains the remaining output and exits with the same code. On stdin EOF or SIGTERM it sends
SIGTERM to the child process group and cleans up with SIGKILL if it does not end within the time limit. Not shipped.

usage: pty-bridge.py <cols> <rows> -- <command> [args...]
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

GRACE_SECONDS = 5.0


def main() -> int:
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        sys.stderr.write("usage: pty-bridge.py <cols> <rows> -- <command> [args...]\n")
        return 2
    cols, rows, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[4:]
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

    stopping_since = None

    def request_stop(*_args) -> None:
        nonlocal stopping_since
        if stopping_since is None:
            stopping_since = time.monotonic()
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, request_stop)
    stdin_open = True
    status = None
    while True:
        if status is None:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done:
                status = raw
        readers = [master] + ([sys.stdin.fileno()] if stdin_open and status is None else [])
        try:
            ready, _, _ = select.select(readers, [], [], 0.05)
        except InterruptedError:
            continue
        if master in ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            elif status is not None:
                break
        elif status is not None:
            break
        if stdin_open and sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if data:
                os.write(master, data)
            else:
                stdin_open = False
                request_stop()
        if stopping_since is not None and status is None and time.monotonic() - stopping_since > GRACE_SECONDS:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    os.close(master)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 128 + os.WTERMSIG(status)


if __name__ == "__main__":
    sys.exit(main())
