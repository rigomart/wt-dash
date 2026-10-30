"""Run a built executable away from its source tree, in a real terminal, and remove a merged worktree with it."""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata

ROWS, COLUMNS = 24, 100
CONTROL = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X].*?(?:\x07|\x1b\\)|[^\]P_^X\[])", re.S)
MOVE = re.compile(r"\x1b\[(\d*)(?:;(\d*))?H$")


class Screen:
    """The dashboard redraws only changed cells, so its raw output doesn't read as text."""

    def __init__(self):
        self.cells = [[" "] * COLUMNS for _ in range(ROWS)]
        self.row = self.column = 0
        self.pending = ""

    def write(self, text):
        text = self.pending + text
        self.pending = ""
        at = 0
        while at < len(text):
            if text[at] == "\x1b":
                match = CONTROL.match(text, at)
                if not match:
                    self.pending = text[at:]
                    return
                move = MOVE.match(match.group())
                if move:
                    self.row = int(move.group(1) or 1) - 1
                    self.column = int(move.group(2) or 1) - 1
                at = match.end()
                continue
            char = text[at]
            at += 1
            if char < " ":
                continue
            if unicodedata.combining(char) or char == "️":
                continue
            if 0 <= self.row < ROWS and self.column < COLUMNS:
                self.cells[self.row][self.column] = char
            self.column += 2 if unicodedata.east_asian_width(char) in "WF" else 1

    def text(self):
        return "\n".join("".join(line).rstrip() for line in self.cells)


binary = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="wt-dash-smoke-") as temporary:
    root = Path(temporary).resolve()
    executable = root / "wt-dash"
    shutil.copy2(binary, executable)
    environment = dict(os.environ, HOME=str(root), XDG_STATE_HOME=str(root / "state"), TERM="xterm-256color",
                       GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                       GIT_AUTHOR_NAME="Release test", GIT_AUTHOR_EMAIL="release@example.invalid",
                       GIT_COMMITTER_NAME="Release test", GIT_COMMITTER_EMAIL="release@example.invalid")
    repo = root / "repo"
    repo.mkdir()
    merged = root / "merged"

    def git(*args, cwd=repo):
        subprocess.run(["git", "-C", str(cwd), *args], env=environment,
                       check=True, capture_output=True)

    git("init", "--initial-branch=main")
    git("commit", "--allow-empty", "-m", "Initial commit")
    git("worktree", "add", "-b", "release-merged", str(merged))
    (merged / "merged.txt").write_text("merged\n")
    git("add", "merged.txt", cwd=merged)
    git("commit", "-m", "Add merged.txt", cwd=merged)
    (repo / "main.txt").write_text("main\n")
    git("add", "main.txt")
    git("commit", "-m", "Add main.txt")
    git("merge", "--squash", "release-merged")
    git("commit", "-m", "Squash release-merged")
    git("worktree", "add", "-b", "release-smoke", str(root / "worktree"))
    subprocess.run([str(executable), "--doctor", str(repo)], cwd=root,
                   env=environment, check=True)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0))
    process = subprocess.Popen([str(executable), str(repo)], cwd=root,
                               env=environment, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    screen = Screen()
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def wait_for(what, ready, seconds=20):
        deadline = time.monotonic() + seconds
        closed = False
        while time.monotonic() < deadline:
            if ready(screen.text()):
                return
            if closed:
                break
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    # Linux reports EIO once the dashboard has closed the terminal.
                    data = b""
                if data:
                    screen.write(decoder.decode(data))
                    continue
            elif process.poll() is None:
                continue
            closed = True
            process.wait(5)
        state = "timed out" if process.poll() is None else f"exited {process.returncode}"
        raise RuntimeError(f"Dashboard {state} waiting for {what}:\n{screen.text()}")

    try:
        wait_for("the scanned worktrees", lambda text: "scanned " in text
                 and re.search(r"□ release-merged +merged ", text)
                 and re.search(r"□ release-smoke +no new commits ", text))
        os.write(master, b"a")
        wait_for("the Safe worktree selected", lambda text: "■ release-merged " in text)
        os.write(master, b"x")
        wait_for("the remove dialog", lambda text: "╭─ Remove 1 worktree" in text)
        os.write(master, b"y")
        wait_for("the removal", lambda text: "✓ Removed 1 worktree · " in text)
        if merged.exists() or not (root / "worktree").exists():
            raise RuntimeError("The removal took the wrong worktree:\n" + screen.text())
        log = [json.loads(line) for line in
               (root / ".cache" / "wt-dash" / "removals.log").read_text().splitlines()]
        if [(entry["branch"], entry["flags"], entry["exitCode"]) for entry in log] != [
                ("release-merged", ["--reap"], 0)]:
            raise RuntimeError(f"Unexpected removals.log: {log}")
        os.write(master, b"q")
        wait_for("the dashboard to quit", lambda text: process.poll() is not None, seconds=5)
        if process.returncode != 0:
            raise RuntimeError(f"Dashboard exited {process.returncode}:\n{screen.text()}")
        print("Standalone dashboard removed a merged worktree and quit successfully.")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
