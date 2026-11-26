#!/usr/bin/env python3
"""publish-api.test.py — offline tests for publish.sh's REST API PR path.

Starts a local mock of the GitHub API (no network), then runs publish.sh with
PUBLISH_API_BASE/PUBLISH_STATE_FILE pointed at the mock. Covers:

  * --check is read-only
  * --dry-run writes no refs and no pull request
  * a full API run creates the ref and the PR
  * a second run updates the existing ref and reuses the open PR (no duplicate)
  * a 500 on the blob POST is retried
  * a 422 from the pull request POST is not retried and prints the body
  * an upstream `main` 404 falls back to `master`
  * a completely failing endpoint stops after PUBLISH_RETRY_MAX with a clear error

Usage:
  python3 test/publish-api.test.py
"""
import base64
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = os.path.join(os.path.expanduser("~"), ".dsh", "github-token")
BASE_SHA = "a" * 40
BASE_TREE = "b" * 40
BLOB_SHA = "c" * 40
TREE_SHA = "d" * 40
COMMIT_SHA = "e" * 40
PR_URL = "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1"
CONTRIB = """# Contributing

Valid `category` values: `agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`
"""


class Mock:
    def __init__(self):
        self.calls = []
        self.ref_exists = False
        self.pulls = []
        self.fail_blob_once = False
        self.fail_pr_422 = False
        self.main_missing = False
        self.drop_path = None
        self.user_attempts = 0
        self.blob_attempts = 0
        self.pr_posts = 0
        self.pull_posts = 0

    def reset_run(self):
        self.calls = []
        self.blob_attempts = 0
        self.pr_posts = 0
        self.pull_posts = 0


def make_handler(mock):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(length) if length else b""

        def _send(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _not_found(self):
            self._send(404, {"message": "Not Found"})

        def do_GET(self):
            mock.calls.append(("GET", self.path))
            path = self.path.split("?")[0]
            if mock.drop_path is not None and path == mock.drop_path:
                if path == "/user":
                    mock.user_attempts += 1
                self.close_connection = True
                self.connection.close()
                return
            if path == "/":
                self._send(200, {"status": "ok"})
            elif path == "/user":
                self._send(200, {"login": "bot-for-imitoy"})
            elif path == "/repos/bot-for-imitoy/dsh-ui-automation":
                self._send(200, {"full_name": "bot-for-imitoy/dsh-ui-automation",
                                 "created_at": "2026-11-20T00:00:00Z"})
            elif path == "/repos/bot-for-imitoy/awesome-dsh-plugin":
                self._send(200, {"full_name": "bot-for-imitoy/awesome-dsh-plugin"})
            elif path.endswith("/git/ref/heads/main"):
                if mock.main_missing:
                    self._not_found()
                else:
                    self._send(200, {"object": {"sha": BASE_SHA, "type": "commit"}})
            elif path.endswith("/git/ref/heads/master"):
                self._send(200, {"object": {"sha": BASE_SHA, "type": "commit"}})
            elif path.endswith(f"/git/commits/{BASE_SHA}"):
                self._send(200, {"tree": {"sha": BASE_TREE}})
            elif path.endswith("/contents/contributing.md"):
                self._send(200, {
                    "content": base64.b64encode(CONTRIB.encode()).decode(),
                    "encoding": "base64",
                })
            elif path.endswith("/git/ref/heads/add-dsh-ui-automation"):
                if mock.ref_exists:
                    self._send(200, {"object": {"sha": COMMIT_SHA}, "ref": "refs/heads/add-dsh-ui-automation"})
                else:
                    self._not_found()
            elif path.endswith("/pulls"):
                self._send(200, mock.pulls)
            else:
                self._not_found()

        def do_POST(self):
            mock.calls.append(("POST", self.path))
            body = self._body()
            path = self.path.split("?")[0]
            if path.endswith("/git/blobs"):
                mock.blob_attempts += 1
                if mock.fail_blob_once and mock.blob_attempts == 1:
                    self._send(500, {"message": "temporary server error"})
                    return
                self._send(201, {"sha": BLOB_SHA})
            elif path.endswith("/git/trees"):
                self._send(201, {"sha": TREE_SHA})
            elif path.endswith("/git/commits"):
                self._send(201, {"sha": COMMIT_SHA})
            elif path.endswith("/git/refs"):
                if mock.ref_exists:
                    self._send(422, {"message": "Reference already exists"})
                    return
                mock.ref_exists = True
                self._send(201, {"ref": "refs/heads/add-dsh-ui-automation", "object": {"sha": COMMIT_SHA}})
            elif path.endswith("/pulls"):
                mock.pr_posts += 1
                if mock.fail_pr_422:
                    self._send(422, {"message": "Validation Failed",
                                     "errors": [{"resource": "PullRequest", "code": "custom",
                                                 "message": "A pull request already exists"}]})
                    return
                pr = {"number": 1, "html_url": PR_URL, "state": "open",
                      "head": {"label": "bot-for-imitoy:add-dsh-ui-automation"}}
                mock.pulls = [pr]
                self._send(201, pr)
            else:
                self._not_found()

        def do_PATCH(self):
            mock.calls.append(("PATCH", self.path))
            self._body()
            self._send(200, {"object": {"sha": COMMIT_SHA}})

    return Handler


def run_script(server, args, retry_max="2", retry_delay="0"):
    env = dict(os.environ)
    for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"):
        env.pop(key, None)
    env.update({
        "PUBLISH_API_BASE": f"http://127.0.0.1:{server.server_port}",
        "PUBLISH_STATE_FILE": os.path.join(ROOT, "test", "out", "publish-state-test.json"),
        "PUBLISH_RETRY_MAX": retry_max,
        "PUBLISH_RETRY_DELAY": retry_delay,
        "PUBLISH_HTTP_TIMEOUT": "10",
    })
    os.makedirs(os.path.join(ROOT, "test", "out"), exist_ok=True)
    return subprocess.run([os.path.join(ROOT, "publish.sh"), *args],
                          cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)


def check(results, name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")


def main():
    if not os.path.exists(TOKEN_FILE):
        raise SystemExit(f"missing token file: {TOKEN_FILE}")
    results = []
    mock = Mock()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(mock))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        # --check is read-only
        mock.reset_run()
        proc = run_script(server, ["--check"])
        writes = [c for c in mock.calls if c[0] in ("POST", "PATCH", "PUT")]
        check(results, "--check is read-only", proc.returncode == 0 and not writes,
              f"exit={proc.returncode}, writes={writes}")

        # dry-run: no ref/PR writes
        mock.reset_run()
        proc = run_script(server, ["--pr-only", "--dry-run"])
        writes = [c for c in mock.calls if c[0] in ("POST", "PATCH") and
                  (c[1].endswith("/git/refs") or c[1].endswith("/pulls"))]
        check(results, "--dry-run skips refs and pulls", proc.returncode == 0 and not writes
              and "dry-run" in proc.stdout and BLOB_SHA in proc.stdout,
              f"exit={proc.returncode}, writes={writes}")
        check(results, "--dry-run validates the category",
              "category 'tools' is valid" in proc.stdout)

        # first real run: create ref + PR
        mock.ref_exists = False
        mock.pulls = []
        mock.reset_run()
        proc = run_script(server, ["--pr-only"])
        check(results, "real API run creates branch and PR",
              proc.returncode == 0 and mock.ref_exists and len(mock.pulls) == 1
              and mock.pr_posts == 1 and PR_URL in proc.stdout,
              f"exit={proc.returncode}, pr_posts={mock.pr_posts}")
        state = json.load(open(os.path.join(ROOT, "test", "out", "publish-state-test.json")))
        check(results, "state file records prUrl", state.get("prUrl") == PR_URL, str(state.get("prUrl")))

        # second run: update ref, reuse PR
        mock.reset_run()
        proc = run_script(server, ["--pr-only"])
        posts = [c for c in mock.calls if c[0] == "POST" and c[1].endswith("/pulls")]
        patches = [c for c in mock.calls if c[0] == "PATCH"]
        check(results, "re-run updates the ref and reuses the open PR",
              proc.returncode == 0 and len(posts) == 0 and len(patches) == 1
              and PR_URL in proc.stdout,
              f"exit={proc.returncode}, pulls POST={len(posts)}, ref PATCH={len(patches)}")

        # 500 on blob: retry succeeds
        mock.fail_blob_once = True
        mock.ref_exists = False
        mock.pulls = []
        mock.reset_run()
        proc = run_script(server, ["--pr-only", "--dry-run"], retry_max="3")
        check(results, "HTTP 500 on blob is retried",
              proc.returncode == 0 and mock.blob_attempts == 2,
              f"attempts={mock.blob_attempts}")
        mock.fail_blob_once = False

        # 422 on PR: no retry, body printed, non-zero exit
        mock.fail_pr_422 = True
        mock.ref_exists = True
        mock.pulls = []
        mock.reset_run()
        proc = run_script(server, ["--pr-only"])
        check(results, "HTTP 422 on pull is not retried",
              proc.returncode != 0 and mock.pr_posts == 1
              and "422" in (proc.stdout + proc.stderr)
              and "Validation Failed" in (proc.stdout + proc.stderr),
              f"exit={proc.returncode}, pr_posts={mock.pr_posts}")
        mock.fail_pr_422 = False

        # main 404 -> master fallback
        mock.main_missing = True
        mock.ref_exists = False
        mock.pulls = []
        mock.reset_run()
        proc = run_script(server, ["--pr-only", "--dry-run"])
        check(results, "missing main falls back to master",
              proc.returncode == 0 and "branch master" in proc.stdout,
              f"exit={proc.returncode}")
        mock.main_missing = False

        # dropped connection on every /user call: network retry budget + clear error
        mock.drop_path = "/user"
        mock.user_attempts = 0
        mock.reset_run()
        proc = run_script(server, ["--pr-only", "--dry-run"], retry_max="2")
        check(results, "dropped connection retries then fails clearly",
              proc.returncode != 0 and "network error on GET /user" in (proc.stdout + proc.stderr)
              and "after 2 attempts" in (proc.stdout + proc.stderr)
              and mock.user_attempts == 2,
              f"exit={proc.returncode}, attempts={mock.user_attempts}")
        mock.drop_path = None
    finally:
        server.shutdown()

    failed = [row for row in results if not row[1]]
    print(f"\npublish API tests: {len(results) - len(failed)}/{len(results)} passed")
    for name, _ok, detail in failed:
        print(f"  FAILED: {name} — {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
