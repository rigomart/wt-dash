"""Run a built executable away from its source tree, in a real terminal."""
import fcntl
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

binary = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="wt-dash-smoke-") as temporary:
    root = Path(temporary)
    executable = root / "wt-dash"
    shutil.copy2(binary, executable)
    environment = dict(os.environ, HOME=str(root), TERM="xterm-256color",
                       GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
    repo = root / "repo"
    repo.mkdir()

    def git(*args):
        subprocess.run(["git", "-C", str(repo), *args], env=environment,
                       check=True, capture_output=True)

    git("init", "--initial-branch=main")
    git("-c", "user.name=Release test", "-c", "user.email=release@example.invalid",
        "commit", "--allow-empty", "-m", "Initial commit")
    git("worktree", "add", "-b", "release-smoke", str(root / "worktree"))
    subprocess.run([str(executable), "--doctor", str(repo)], cwd=root,
                   env=environment, check=True)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    process = subprocess.Popen([str(executable), str(repo)], cwd=root,
                               env=environment, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()
    deadline = time.monotonic() + 20
    quit_sent = False
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                if not quit_sent or process.returncode != 0:
                    raise RuntimeError("Dashboard failed:\n" + output.decode(errors="replace"))
                print("Standalone dashboard rendered a real worktree and quit successfully.")
                break
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    # A closed pseudo-terminal reports EIO; inspect the exit on the next iteration.
                    continue
            if not quit_sent and b"release-smoke" in output and b"no new commits" in output:
                os.write(master, b"q")
                quit_sent = True
                deadline = time.monotonic() + 5
        else:
            raise RuntimeError("Dashboard did not render the test worktree:\n" + output.decode(errors="replace"))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
