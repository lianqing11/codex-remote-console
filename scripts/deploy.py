"""Release the committed frontend, keep one previous release for open tabs, prune the rest.

  python scripts/deploy.py                    # build, start, switch nginx, prune
  python scripts/deploy.py --restart-backend  # also restart the backend once no agent turn runs

Host settings come from the environment or .env.local:
  CODEX_WEB_DEPLOY_NGINX_CONF       nginx location file this script owns
  CODEX_WEB_DEPLOY_NGINX_CONTAINER  docker container running nginx
  CODEX_WEB_DEPLOY_PUBLIC_URL       public console URL, used for verification
  CODEX_WEB_DEPLOY_BACKEND_PANE     tmux pane running the backend (default codex_web_cursor:0.0)
"""
import argparse
import json
import os
import re
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT / ".codex_web" / "releases"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
LOCAL = dict(
    line.split("=", 1) for line in (ROOT / ".env.local").read_text().splitlines()
    if re.match(r"^[A-Z_][A-Z0-9_]*=", line)
) if (ROOT / ".env.local").exists() else {}


def setting(name, default=None):
    value = os.environ.get(name) or LOCAL.get(name, "").strip().strip("'\"") or default
    if value is None:
        sys.exit(f"{name} is required (environment or .env.local)")
    return value


BASE = setting("NEXT_PUBLIC_BASE_PATH", "/codex_web_cursor").rstrip("/")
BACKEND_PORT = int(setting("PORT", "3032"))
NGINX_CONF = Path(setting("CODEX_WEB_DEPLOY_NGINX_CONF"))
NGINX_CONTAINER = setting("CODEX_WEB_DEPLOY_NGINX_CONTAINER")
PUBLIC_URL = setting("CODEX_WEB_DEPLOY_PUBLIC_URL")
BACKEND_PANE = setting("CODEX_WEB_DEPLOY_BACKEND_PANE", "codex_web_cursor:0.0")
CLEAN_ENV = {k: v for k, v in os.environ.items()
             if not re.match(r"^(https?_proxy|all_proxy|HTTPS?_PROXY|ALL_PROXY|NEXT_DIST_DIR|PORT)$", k)}


def log(message):
    print(f"[deploy] {message}", flush=True)


def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def get(url, timeout=5):
    with OPENER.open(url, timeout=timeout) as response:
        return response.read().decode()


def wait_http(url, seconds=90):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return get(url)
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(1)


def page_chunk(html):
    return re.search(r"/_next/static/chunks/app/page-[0-9a-f]+\.js", html).group()


def console_processes():
    """Listening Next frontends started from this checkout: {pid: (port, dist)}."""
    found = {}
    listening = subprocess.run(["ss", "-ltnpH"], capture_output=True, text=True).stdout
    for port, pid in re.findall(r"127\.0\.0\.1:(\d+)\s.*?pid=(\d+)", listening):
        try:
            is_next = b"next-server" in Path(f"/proc/{pid}/cmdline").read_bytes()
            from_here = os.readlink(f"/proc/{pid}/cwd") == str(ROOT)
        except OSError:
            continue
        if is_next and from_here:
            found[int(pid)] = (int(port), process_env(pid).get("NEXT_DIST_DIR", ".next"))
    return found


def backend_pid():
    out = subprocess.run(["ss", "-ltnpH", f"sport = :{BACKEND_PORT}"], capture_output=True, text=True).stdout
    match = re.search(r"pid=(\d+)", out)
    return int(match.group(1)) if match else None


def process_env(pid):
    raw = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    return dict(item.decode().split("=", 1) for item in raw if b"=" in item)


def nginx_conf(port, previous):
    """Current release, one previous release for already-open tabs, then the backend."""
    proxy = "    proxy_set_header Host $host;\n    proxy_http_version 1.1;\n"
    chain = "    proxy_intercept_errors on;\n    recursive_error_pages on;\n"
    fallback = f"@console_release_{previous}" if previous else "@console_release_backend"
    text = f"""# Managed by scripts/deploy.py; edits are overwritten on the next release.
location = {BASE}/ {{
    proxy_pass http://127.0.0.1:{port}/;
{proxy}    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Cache-Control "no-cache";
}}

location {BASE}/_next/ {{
    proxy_pass http://127.0.0.1:{port}/_next/;
{proxy}{chain}    error_page 404 = {fallback};
}}
"""
    if previous:
        text += f"""
location @console_release_{previous} {{
    rewrite ^{BASE}/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:{previous};
{proxy}{chain}    error_page 404 = @console_release_backend;
}}
"""
    return text + f"""
location @console_release_backend {{
    rewrite ^{BASE}/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:{BACKEND_PORT};
{proxy}}}
"""


def switch_nginx(text):
    before = NGINX_CONF.read_text()
    NGINX_CONF.write_text(text)
    try:
        run(["docker", "exec", NGINX_CONTAINER, "nginx", "-t"], capture_output=True)
        run(["docker", "exec", NGINX_CONTAINER, "nginx", "-s", "reload"])
    except subprocess.CalledProcessError:
        NGINX_CONF.write_text(before)
        raise
    return before


def build(dist):
    # `next build` rewrites these to point at the dist directory; keep the tracked versions.
    kept = {name: (ROOT / name).read_text() for name in ("tsconfig.json", "next-env.d.ts")}
    try:
        run(["npm", "run", "-s", "build"], env=dict(CLEAN_ENV, NEXT_DIST_DIR=dist, NEXT_PUBLIC_BASE_PATH=BASE))
    finally:
        for name, text in kept.items():
            (ROOT / name).write_text(text)


def start_frontend(dist):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    command = shlex.join(["env", f"NEXT_DIST_DIR={dist}", f"NEXT_PUBLIC_BASE_PATH={BASE}",
                          "./node_modules/.bin/next", "start", "-H", "127.0.0.1", "-p", str(port)])
    log_file = shlex.quote(str(LOG_DIR / f"{dist.lstrip('.')}.log"))
    run(["tmux", "new-session", "-d", "-s", f"console-{dist.lstrip('.')}", "-c", str(ROOT), f"{command} >> {log_file} 2>&1"])
    wait_http(f"http://127.0.0.1:{port}/")
    return port


def prune(keep_ports, keep_dists):
    backend_group = os.getpgid(backend_pid())
    for pid, (port, _) in console_processes().items():
        if port in keep_ports:
            continue
        group = os.getpgid(pid)
        log(f"stopping frontend on {port} (pid {pid})")
        os.killpg(group, 15) if group != backend_group else os.kill(pid, 15)
    for path in ROOT.glob(".next-*"):
        if path.is_dir() and path.name not in keep_dists:
            log(f"removing {path.name}")
            shutil.rmtree(path)


def busy(pid):
    children = subprocess.run(["pgrep", "-P", str(pid), "-f", "claude -p|cursor-agent"], capture_output=True, text=True).stdout.split()
    queue = Path(setting("CODING_AGENT_CONSOLE_STATE_DIR", str(Path.home() / ".local/share/coding-agent-console"))) / "queue.sqlite"
    with sqlite3.connect(f"file:{queue}?mode=ro", uri=True) as conn:
        queued = conn.execute("SELECT count(*) FROM queue_items WHERE status IN ('dispatching','running','waiting_for_input')").fetchone()[0]
    login = urllib.request.Request(f"http://127.0.0.1:{BACKEND_PORT}/api/auth/login", method="POST",
                                   data=json.dumps({"password": setting("CODEX_WEB_PASSWORD")}).encode(),
                                   headers={"content-type": "application/json"})
    cookie = OPENER.open(login, timeout=10).headers["set-cookie"].split(";", 1)[0]
    boot = json.loads(OPENER.open(urllib.request.Request(f"http://127.0.0.1:{BACKEND_PORT}/api/bootstrap", headers={"cookie": cookie}), timeout=30).read())
    states = [str((s.get("status") or {}).get("type") if isinstance(s.get("status"), dict) else s.get("status")).replace("_", "").replace("-", "").lower()
              for provider in (boot.get("providers") or {}).values() for s in provider.get("sessions") or []]
    running = sum(state in ("running", "inprogress", "active", "waitingforinput") for state in states)
    return len(children) + queued + running


def restart_backend(dist):
    """Wait until no agent turn runs, then restart the backend in its tmux pane."""
    pid = backend_pid()
    while True:
        if not busy(pid):
            time.sleep(5)
            if not busy(pid):
                break
        time.sleep(10)
    log("backend idle; restarting")
    run(["tmux", "send-keys", "-t", BACKEND_PANE, "C-c"])
    deadline = time.monotonic() + 60
    while subprocess.check_output(["tmux", "display-message", "-p", "-t", BACKEND_PANE, "#{pane_current_command}"], text=True).strip() != "bash":
        assert time.monotonic() < deadline, "backend pane did not return to a shell"
        time.sleep(0.5)
    command = shlex.join(["env", "NODE_ENV=production", f"NEXT_DIST_DIR={dist}", f"NEXT_PUBLIC_BASE_PATH={BASE}",
                          f"PORT={BACKEND_PORT}", "./node_modules/.bin/tsx", "server/index.ts"])
    log_file = shlex.quote(str(LOG_DIR / "backend.log"))
    run(["tmux", "send-keys", "-t", BACKEND_PANE, f"cd {shlex.quote(str(ROOT))} && {command} >> {log_file} 2>&1", "C-m"])
    wait_http(f"http://127.0.0.1:{BACKEND_PORT}/")
    log(f"backend healthy on {BACKEND_PORT} (pid {backend_pid()})")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--restart-backend", action="store_true", help="restart the backend once idle (runs detached)")
    parser.add_argument("--backend-only", metavar="DIST", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.backend_only:
        return restart_backend(args.backend_only)

    if subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True).stdout.strip():
        sys.exit("Working tree has uncommitted changes; deploy releases committed code only.")
    sha = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    dist = f".next-release-{sha}"

    current = re.search(r"location = \S+ \{\s*proxy_pass http://127\.0\.0\.1:(\d+)/", NGINX_CONF.read_text())
    previous = int(current.group(1)) if current else None
    log(f"building {sha} into {dist}")
    build(dist)
    port = start_frontend(dist)
    log(f"frontend {sha} up on {port}; previous release on {previous}")

    switch_nginx(nginx_conf(port, previous))
    expected = page_chunk((ROOT / dist / "server/app/index.html").read_text())
    deadline = time.monotonic() + 30
    while page_chunk(get(PUBLIC_URL)) != expected:
        assert time.monotonic() < deadline, "public URL does not serve the new release"
        time.sleep(1)
    log(f"public URL serves {sha}")

    processes = console_processes()
    keep_ports = {port, previous}
    keep_dists = {dist, process_env(backend_pid()).get("NEXT_DIST_DIR", ".next")}
    keep_dists |= {d for p, d in processes.values() if p in keep_ports}
    prune(keep_ports, keep_dists)

    if args.restart_backend:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_DIR / "backend-restart.log", "a") as out:
            subprocess.Popen([sys.executable, __file__, "--backend-only", dist], cwd=ROOT, stdout=out, stderr=out,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        log(f"backend restart scheduled once idle; see {LOG_DIR / 'backend-restart.log'}")


if __name__ == "__main__":
    main()
