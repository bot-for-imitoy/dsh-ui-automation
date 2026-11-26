#!/usr/bin/env bash
# publish.sh — publish dsh-ui-automation to GitHub and open the awesome-list PR.
#
# Idempotent: every step checks the remote state first, so it is safe to re-run
# after a failure or after the network comes back.
#
#   ./publish.sh                 full pipeline (repo + topics + fork + entry + PR)
#   ./publish.sh --check         only verify token, network and current state
#   ./publish.sh --repo-only     create/push the repository and topics, stop there
#   ./publish.sh --pr-only       fork/entry/PR only (repository already published)
#   ./publish.sh --force-pr      ignore the "repository is 1 day old" gate
#   ./publish.sh --category ID   override the awesome-list category (default: tools)
#   ./publish.sh --api|--clone   API path (default) or legacy clone path for the PR
#   ./publish.sh --dry-run       with --pr-only: compute the entry and create the
#                                blob/tree/commit, but do not write refs or a PR
#
# The PR stage uses the GitHub REST API by default (--api): it creates a blob,
# tree and commit on the fork and opens the PR without cloning the list. All
# requests are small JSON and retried on network errors, so the flaky proxy does
# not need a lucky 600 MB clone.
#
#   ./publish.sh --pr-only --dry-run   compute upstream base, entry blob/tree and
#                                      commit sha; do not write refs or open a PR
#   ./publish.sh --pr-only --clone     legacy path: clone the fork and git push
#
# Token: read from $GITHUB_TOKEN_FILE (default ~/.dsh/github-token). It is only
# handed to curl through a 0600 netrc file and to git through a 0600 askpass
# script; it is never placed in argv, config, logs or the repository.
# Network retries: PUBLISH_RETRY_MAX (default 6), PUBLISH_RETRY_DELAY (2s),
# PUBLISH_HTTP_TIMEOUT (45s). PUBLISH_API_BASE and PUBLISH_STATE_FILE exist for
# offline tests of this script.

set -euo pipefail
umask 077

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_NAME="dsh-ui-automation"
AWESOME_SLUG="awesome-dsh-plugin/awesome-dsh-plugin"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-$HOME/.dsh/github-token}"
CATEGORY="${AWESOME_CATEGORY:-tools}"
MODE="full"
PR_MODE="api"
DRY_RUN=0
FORCE_PR=0
MIN_COMMITS=10
MIN_REPO_AGE_SECONDS=86400
API_BASE="${PUBLISH_API_BASE:-https://api.github.com}"
STATE_FILE="${PUBLISH_STATE_FILE:-$ROOT/.publish-state.json}"
RETRY_MAX="${PUBLISH_RETRY_MAX:-6}"
RETRY_DELAY="${PUBLISH_RETRY_DELAY:-2}"
HTTP_TIMEOUT="${PUBLISH_HTTP_TIMEOUT:-45}"

usage() {
    sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
info() { printf '• %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
    case "$1" in
        --check) MODE="check"; shift ;;
        --repo-only) MODE="repo"; shift ;;
        --pr-only) MODE="pr"; shift ;;
        --api) PR_MODE="api"; shift ;;
        --clone) PR_MODE="clone"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --force-pr) FORCE_PR=1; shift ;;
        --category) CATEGORY="${2:?--category needs a value}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

if [ "$DRY_RUN" -eq 1 ]; then
    [ "$MODE" = "pr" ] || die "--dry-run is only supported with --pr-only (it must not create the repository or push)"
    [ "$PR_MODE" = "api" ] || die "--dry-run requires the API path (drop --clone)"
fi

for tool in curl git python3; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
[ -f "$TOKEN_FILE" ] || die "token file not found: $TOKEN_FILE"
case "$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || echo '')" in
    600|400) ;;
    *) warn "token file is not 0600: chmod 600 '$TOKEN_FILE'" ;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/dsh-publish.XXXXXX")
NETRC="$TMP/netrc"
ASKPASS="$TMP/askpass"
RESP_FILE="$TMP/resp.json"
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT

# Netrc: curl authenticates with basic auth (any login, token as password).
# The API host is included as well so PUBLISH_API_BASE can point at a local
# mock server in the offline tests without putting the token in argv.
API_HOST=$(python3 -c 'import sys, urllib.parse
host = urllib.parse.urlparse(sys.argv[1]).hostname
print(host or "api.github.com")' "$API_BASE")
{
    for host in api.github.com "$API_HOST"; do
        printf 'machine %s\n  login x\n  password ' "$host"
        tr -d '\r\n' < "$TOKEN_FILE"
        printf '\n'
    done
} > "$NETRC"
chmod 600 "$NETRC"

# Askpass: git gets the username and the token from files, never from argv.
cat > "$ASKPASS" <<'ASKPASS_EOF'
#!/bin/sh
case "$1" in
    Username*) printf '%s\n' "${GIT_USER:-x}" ;;
    *) { tr -d '\r\n' < "${GIT_TOKEN_FILE:?}"; printf '\n'; } ;;
esac
ASKPASS_EOF
chmod 700 "$ASKPASS"
export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 GIT_TOKEN_FILE="$TOKEN_FILE"

# ---------------------------------------------------------------- helpers
API_CODE=""
API_BODY=""

# One API request with retries for network errors, 5xx and 429. HTTP 4xx is a
# caller problem and is returned as-is; callers use require_code/api_error to
# fail with the response body instead of retrying.
api() {
    local method="$1" path="$2" body="${3:-}"
    local attempt=1 delay="$RETRY_DELAY" rc code
    while :; do
        local args=(-sS -m "$HTTP_TIMEOUT" --netrc-file "$NETRC" -X "$method"
            -H 'Accept: application/vnd.github+json'
            -H 'X-GitHub-Api-Version: 2022-11-28'
            -H 'Content-Type: application/json'
            -o "$RESP_FILE" -w '%{http_code}')
        rc=0
        if [ -n "$body" ]; then
            if [ "${body#@}" != "$body" ]; then
                code=$(curl "${args[@]}" --data-binary "@${body#@}" "$API_BASE$path" 2>"$TMP/curlerr") || rc=$?
            else
                code=$(curl "${args[@]}" --data "$body" "$API_BASE$path" 2>"$TMP/curlerr") || rc=$?
            fi
        else
            code=$(curl "${args[@]}" "$API_BASE$path" 2>"$TMP/curlerr") || rc=$?
        fi
        API_CODE="${code:-000}"
        API_BODY=$(cat "$RESP_FILE" 2>/dev/null || true)
        local retriable=0
        if [ "$rc" -ne 0 ] || [ "$API_CODE" = "000" ] || [ "${API_CODE:0:1}" = "5" ] \
            || [ "$API_CODE" = "429" ]; then
            retriable=1
        fi
        [ "$retriable" -eq 0 ] && return 0
        if [ "$attempt" -ge "$RETRY_MAX" ]; then
            die "network error on $method $path after $attempt attempts (curl rc=$rc, HTTP $API_CODE): $(tr -d '\r\n' < "$TMP/curlerr" 2>/dev/null | tail -c 300)"
        fi
        warn "network error on $method $path (curl rc=$rc, HTTP $API_CODE); retry $attempt/$RETRY_MAX in ${delay}s"
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
        [ "$delay" -gt 30 ] && delay=30
    done
}

# Human-readable error detail for the last response (message / errors / raw).
api_error() {
    python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
    message = data.get("message") or ""
    errors = data.get("errors")
    if errors:
        message = f"{message} {errors}" if message else str(errors)
    print((message or raw)[:500])
except Exception:
    print(raw[:500])
' <<<"$API_BODY" 2>/dev/null || true
}

# Fail unless the last HTTP status is one of the accepted ones.
require_code() {
    local desc="$1"; shift
    local code
    for code in "$@"; do
        [ "$API_CODE" = "$code" ] && return 0
    done
    die "$desc failed (HTTP $API_CODE): $(api_error)"
}

# Read a dotted field out of the last API response.
jget() {
    python3 -c '
import json, sys
d = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    d = d[int(part)] if isinstance(d, list) else d.get(part)
    if d is None:
        break
print("" if d is None else d)
' "$1" <<<"$API_BODY" 2>/dev/null || true
}

git_cred() { git -c credential.helper= "$@"; }

write_state() {
    python3 - "$STATE_FILE" "$OWNER" "$REPO_URL" "${PR_URL:-}" "$CATEGORY" <<'PY'
import datetime, json, sys
path, owner, repo_url, pr_url, category = sys.argv[1:6]
state = {
    "owner": owner,
    "repoUrl": repo_url,
    "prUrl": pr_url,
    "category": category,
    "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
}

# ---------------------------------------------------------------- entry helpers
# Render the local awesome-entry.yml for the authenticated owner.
render_entry() {
    local out="$1"
    sed "s/__OWNER__/$OWNER/g" "$ROOT/awesome-entry.yml" > "$out"
}

# Same validation as the clone path: url/name, category present, and a
# single-line description.en that ends with a period.
validate_entry() {
    python3 - "$1" "$OWNER" "$REPO_NAME" <<'ENTRY_PY'
import re
import sys

path, owner, repo = sys.argv[1:4]
text = open(path, encoding="utf-8").read()

def scalar(key):
    match = re.search(rf"^{re.escape(key)}:[ \t]*(.+?)[ \t]*$", text, re.M)
    value = match.group(1).strip() if match else ""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("\"", "'"):
        value = value[1:-1]
    return value

url = scalar("url")
name = scalar("name")
category = scalar("category")
match = re.search(r"^[ \t]+en:[ \t]*(.+?)[ \t]*$", text, re.M)
en = match.group(1).rstrip() if match else ""
if len(en) >= 2 and en[0] == en[-1] and en[0] in ("\"", "'"):
    en = en[1:-1]

problems = []
expected = f"https://github.com/{owner}/{repo}"
if url != expected:
    problems.append(f"url must be {expected} (got {url!r})")
if name != f"{owner}/{repo}":
    problems.append(f"name must be {owner}/{repo} (got {name!r})")
if not category:
    problems.append("category is missing")
if en == "":
    problems.append("description.en is missing")
elif not en.endswith("."):
    problems.append("description.en must end with a period")
if problems:
    print("\u2717 entry validation failed:")
    for problem in problems:
        print(f"  - {problem}")
    raise SystemExit(1)
print("\u2713 entry validated (url, name, category, single-line description.en)")
ENTRY_PY
}

# The list has no data/categories.yml; contributing.md carries the canonical
# list. Fetch it through the API so the API path can verify the category without
# cloning, with the same list as a fallback when the document is unreachable.
BUILTIN_CATEGORIES="agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun"

validate_category_api() {
    local category="$1"
    local doc="$TMP/contributing.md"
    local fetched=0
    local file
    for file in contributing.md CONTRIBUTING.md Contributing.md; do
        api GET "/repos/$AWESOME_SLUG/contents/$file"
        if [ "$API_CODE" = "200" ]; then
            printf '%s' "$API_BODY" > "$TMP/contributing.json"
            if python3 - "$doc" "$TMP/contributing.json" <<'CAT_PY'
import base64, json, sys
data = json.load(open(sys.argv[2], encoding="utf-8"))
text = base64.b64decode(data.get("content", "")).decode("utf-8", "replace")
open(sys.argv[1], "w", encoding="utf-8").write(text)
CAT_PY
            then
                fetched=1
                break
            fi
        fi
    done
    local valid="$BUILTIN_CATEGORIES"
    local category_source="built-in list"
    if [ "$fetched" -eq 1 ]; then
        local parsed
        parsed=$(python3 - "$doc" <<'PARSE_PY' || true
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"Valid `category` values[^\n]*\n+([^\n]+)", text)
line = match.group(1) if match else ""
cats = re.findall(r"`([a-z0-9_-]+)`", line)
if not cats:
    match = re.search(r"`category`[^\n]*\n+([^\n]+)", text)
    cats = re.findall(r"`([a-z0-9_-]+)`", match.group(1)) if match else []
print(" ".join(cats))
PARSE_PY
)
        if [ -n "$parsed" ]; then
            valid="$parsed"
            category_source="contributing.md"
        else
            warn "could not parse the category list from contributing.md; using the built-in list"
        fi
    else
        warn "could not fetch contributing.md; validating against the built-in category list"
    fi
    case " $valid " in
        *" $category "*) ;;
        *) die "category '$category' is not in the official list; pick one of: $valid" ;;
    esac
    ok "category '$category' is valid (from $category_source)"
}

# ---------------------------------------------------------------- API PR path
# Create blob -> tree -> commit on the fork through the REST API, update the
# branch ref, and open (or reuse) the pull request. No clone, no git push.
api_pr() {
    local fork="$OWNER/awesome-dsh-plugin"
    local branch="add-$REPO_NAME"
    local base_branch base_sha base_tree
    local entry_path entry_file
    local title body payload blob_sha tree_sha commit_sha

    # --- base: upstream ref (main, then master) -------------------------
    api GET "/repos/$AWESOME_SLUG/git/ref/heads/main"
    if [ "$API_CODE" = "200" ]; then
        base_branch="main"
    elif [ "$API_CODE" = "404" ]; then
        api GET "/repos/$AWESOME_SLUG/git/ref/heads/master"
        require_code "locating upstream default branch (main/master)" 200
        base_branch="master"
    else
        require_code "locating upstream default branch" 200
    fi
    base_sha=$(jget object.sha)
    [ -n "$base_sha" ] || die "upstream ref has no commit sha"
    info "upstream $AWESOME_SLUG@$base_branch: $base_sha"

    api GET "/repos/$AWESOME_SLUG/git/commits/$base_sha"
    require_code "reading upstream commit" 200
    base_tree=$(jget tree.sha)
    [ -n "$base_tree" ] || die "upstream commit has no tree sha"
    info "base tree: $base_tree"

    # --- entry ----------------------------------------------------------
    entry_path="data/plugins/${OWNER}__${REPO_NAME}.yml"
    entry_file="$TMP/entry.yml"
    render_entry "$entry_file"
    validate_entry "$entry_file"
    validate_category_api "$CATEGORY"
    ok "entry: $entry_path ($(wc -c < "$entry_file") bytes)"

    # --- blob -----------------------------------------------------------
    payload="$TMP/blob.json"
    python3 - "$entry_file" "$payload" <<'BLOB_PY'
import json, sys
text = open(sys.argv[1], encoding="utf-8").read()
json.dump({"content": text, "encoding": "utf-8"},
          open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
BLOB_PY
    api POST "/repos/$fork/git/blobs" "@$payload"
    require_code "creating blob on the fork" 201 200
    blob_sha=$(jget sha)
    [ -n "$blob_sha" ] || die "blob response has no sha"
    ok "blob: $blob_sha"

    # --- tree -----------------------------------------------------------
    payload="$TMP/tree.json"
    python3 - "$base_tree" "$entry_path" "$blob_sha" "$payload" <<'TREE_PY'
import json, sys
base_tree, path, blob, out = sys.argv[1:5]
json.dump({
    "base_tree": base_tree,
    "tree": [{"path": path, "mode": "100644", "type": "blob", "sha": blob}],
}, open(out, "w", encoding="utf-8"), ensure_ascii=False)
TREE_PY
    api POST "/repos/$fork/git/trees" "@$payload"
    require_code "creating tree on the fork" 201 200
    tree_sha=$(jget sha)
    [ -n "$tree_sha" ] || die "tree response has no sha"
    ok "tree: $tree_sha"

    # --- commit ---------------------------------------------------------
    title=$(sed -n 's/^Title:[[:space:]]*//p' "$ROOT/PR.md" | head -n 1)
    body=$(sed -n '/^Body:/,$p' "$ROOT/PR.md" | tail -n +2)
    [ -n "$title" ] || die "PR.md has no 'Title:' line"
    payload="$TMP/commit.json"
    python3 - "$title" "$tree_sha" "$base_sha" "$payload" <<'COMMIT_PY'
import json, sys
title, tree, parent, out = sys.argv[1:5]
json.dump({
    "message": title,
    "tree": tree,
    "parents": [parent],
}, open(out, "w", encoding="utf-8"), ensure_ascii=False)
COMMIT_PY
    api POST "/repos/$fork/git/commits" "@$payload"
    require_code "creating commit on the fork" 201 200
    commit_sha=$(jget sha)
    [ -n "$commit_sha" ] || die "commit response has no sha"
    ok "commit: $commit_sha"

    if [ "$DRY_RUN" -eq 1 ]; then
        printf '\n'
        ok "dry-run: nothing was written to refs or pull requests"
        info "entry:   $entry_path"
        info "base:    $base_sha (tree $base_tree, branch $base_branch)"
        info "blob:    $blob_sha"
        info "tree:    $tree_sha"
        info "commit:  $commit_sha"
        info "next:    drop --dry-run to create refs/heads/$branch and open the PR"
        info "note:    the blob/tree/commit objects are dangling until the ref is written"
        exit 0
    fi

    # --- branch ref (create, or force-update when it already exists) -----
    api GET "/repos/$fork/git/ref/heads/$branch"
    case "$API_CODE" in
        200)
            payload="$TMP/ref.json"
            python3 - "$commit_sha" "$payload" <<'REF_PY'
import json, sys
json.dump({"sha": sys.argv[1], "force": True}, open(sys.argv[2], "w", encoding="utf-8"))
REF_PY
            api PATCH "/repos/$fork/git/refs/heads/$branch" "@$payload"
            require_code "updating fork branch $branch" 200
            ok "branch $branch updated to $commit_sha"
            ;;
        404)
            payload="$TMP/ref.json"
            python3 - "$branch" "$commit_sha" "$payload" <<'REF_PY'
import json, sys
json.dump({"ref": f"refs/heads/{sys.argv[1]}", "sha": sys.argv[2]},
          open(sys.argv[3], "w", encoding="utf-8"))
REF_PY
            api POST "/repos/$fork/git/refs" "@$payload"
            if [ "$API_CODE" = "422" ]; then
                python3 - "$commit_sha" "$payload" <<'REF_PY'
import json, sys
json.dump({"sha": sys.argv[1], "force": True}, open(sys.argv[2], "w", encoding="utf-8"))
REF_PY
                api PATCH "/repos/$fork/git/refs/heads/$branch" "@$payload"
                require_code "updating fork branch $branch after 422" 200
                ok "branch $branch updated to $commit_sha"
            else
                require_code "creating fork branch $branch" 201
                ok "branch $branch created at $commit_sha"
            fi
            ;;
        *)
            require_code "inspecting fork branch $branch" 200 404
            ;;
    esac

    # --- pull request: reuse an open one, otherwise create ---------------
    local head_query
    head_query=$(python3 -c 'import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=""))' "$OWNER:$branch")
    api GET "/repos/$AWESOME_SLUG/pulls?state=open&head=$head_query"
    require_code "checking for an existing pull request" 200
    PR_URL=$(python3 -c '
import json, sys
pulls = json.load(sys.stdin)
print(pulls[0]["html_url"] if pulls else "")' <<<"$API_BODY" 2>/dev/null || true)

    if [ -n "${PR_URL:-}" ]; then
        ok "open pull request already exists: $PR_URL"
    else
        info "opening pull request against $AWESOME_SLUG ($base_branch)"
        payload="$TMP/pr.json"
        python3 - "$title" "$body" "$OWNER" "$branch" "$base_branch" "$payload" <<'PR_PY'
import json, sys
title, body, owner, branch, base, out = sys.argv[1:7]
json.dump({
    "title": title,
    "head": f"{owner}:{branch}",
    "base": base,
    "body": body,
    "maintainer_can_modify": True,
}, open(out, "w", encoding="utf-8"), ensure_ascii=False)
PR_PY
        api POST "/repos/$AWESOME_SLUG/pulls" "@$payload"
        if [ "$API_CODE" = "422" ]; then
            # Keep the 422 body before the re-check overwrites API_BODY.
            local pr_error
            pr_error=$(api_error)
            api GET "/repos/$AWESOME_SLUG/pulls?state=open&head=$head_query"
            PR_URL=$(python3 -c '
import json, sys
pulls = json.load(sys.stdin)
print(pulls[0]["html_url"] if pulls else "")' <<<"$API_BODY" 2>/dev/null || true)
            [ -n "${PR_URL:-}" ] || die "opening the PR failed (HTTP 422): $pr_error"
            ok "open pull request already exists: $PR_URL"
        else
            require_code "opening the pull request" 201
            PR_URL=$(jget html_url)
            ok "pull request opened: $PR_URL"
        fi
    fi

    write_state
    printf '\n'
    info "done."
    info "repository: $REPO_URL"
    info "pull request: ${PR_URL:-none}"
    info "state: $STATE_FILE"
}

# ---------------------------------------------------------------- preflight
info "token file: $TOKEN_FILE"
NET_CODE=$(curl -m 20 -sS -o /dev/null -w '%{http_code}' "$API_BASE/" 2>/dev/null || true)
case "$NET_CODE" in
    200|401|403) ok "api.github.com reachable (HTTP $NET_CODE)" ;;
    *)
        die "$API_BASE is not reachable (got '$NET_CODE').
  This machine currently cannot reach GitHub (TLS handshake aborted). Nothing
  was changed. Re-run this script when the network is back; all repository and
  entry work is already done offline. See PUBLISH.md."
        ;;
esac

api GET /user
[ "$API_CODE" = "200" ] || die "token rejected (HTTP $API_CODE): $(jget message)"
OWNER=$(jget login)
[ -n "$OWNER" ] || die "could not determine the token owner"
REPO_URL="https://github.com/$OWNER/$REPO_NAME"
ok "authenticated as $OWNER"

if [ "$MODE" = "check" ]; then
    api GET "/repos/$OWNER/$REPO_NAME"
    case "$API_CODE" in
        200) ok "repository exists: https://github.com/$OWNER/$REPO_NAME" ;;
        404) info "repository not created yet: $OWNER/$REPO_NAME" ;;
        *) require_code "checking the repository" 200 404 ;;
    esac
    api GET "/repos/$OWNER/awesome-dsh-plugin"
    case "$API_CODE" in
        200) ok "awesome-list fork exists: https://github.com/$OWNER/awesome-dsh-plugin" ;;
        404) info "awesome-list fork not created yet" ;;
        *) require_code "checking the fork" 200 404 ;;
    esac
    ok "check complete (read-only)"
    exit 0
fi

cd "$ROOT"

# Fill the repository-owner placeholder on the first real run. publish.sh and
# PUBLISH.md keep the literal placeholder on purpose and are excluded.
if git grep -q -e '__OWNER__' -- . ':(exclude)publish.sh' ':(exclude)PUBLISH.md' 2>/dev/null; then
    git grep -l -e '__OWNER__' -- . ':(exclude)publish.sh' ':(exclude)PUBLISH.md' \
        | while IFS= read -r file; do
            sed -i "s/__OWNER__/$OWNER/g" "$file"
        done
    git add -A
    if ! git diff --cached --quiet; then
        git commit -q -m "chore: point repository metadata at $OWNER"
        ok "filled in the repository owner ($OWNER) and committed it"
    fi
fi

# ---------------------------------------------------------------- repository
if [ "$MODE" = "full" ] || [ "$MODE" = "repo" ]; then
    api GET "/repos/$OWNER/$REPO_NAME"
    if [ "$API_CODE" = "200" ]; then
        ok "repository already exists: $REPO_URL"
    elif [ "$API_CODE" = "404" ]; then
        info "creating public repository $OWNER/$REPO_NAME"
        api POST /user/repos "$(python3 -c '
import json, sys
print(json.dumps({
    "name": sys.argv[1],
    "description": sys.argv[2],
    "private": False,
    "has_issues": True,
    "has_projects": False,
    "has_wiki": False,
    "auto_init": False,
}, ensure_ascii=False))' "$REPO_NAME" \
    "Headless Xvfb UI automation for DSH: click, type, drag and screenshot GUI apps through AT-SPI with state readback after every action.")"
        [ "$API_CODE" = "201" ] || die "repository creation failed (HTTP $API_CODE): $(jget message)"
        ok "repository created: $REPO_URL"
    else
        die "cannot inspect repository (HTTP $API_CODE): $(jget message)"
    fi

    if git remote get-url origin >/dev/null 2>&1; then
        git remote set-url origin "https://github.com/$OWNER/$REPO_NAME.git"
    else
        git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
    fi
    info "pushing main to origin"
    git_cred push -u origin main || die "git push failed (network or permissions)"
    ok "main pushed"

    info "setting repository topics"
    api PUT "/repos/$OWNER/$REPO_NAME/topics" \
        '{"names":["dsh-plugin","dsh","ui-automation","at-spi","xvfb","gui-testing"]}'
    [ "$API_CODE" = "200" ] || die "setting topics failed (HTTP $API_CODE): $(jget message)"
    ok "topics set (dsh-plugin, dsh, ui-automation, at-spi, xvfb, gui-testing)"

    write_state
    if [ "$MODE" = "repo" ]; then
        ok "repository step complete; run with --pr-only when the repository is 1 day old"
        exit 0
    fi
fi

# ---------------------------------------------------------------- awesome list
COMMITS=$(git rev-list --count HEAD)
[ "$COMMITS" -ge "$MIN_COMMITS" ] || die "repository has $COMMITS commits, the list requires at least $MIN_COMMITS"
info "commit count: $COMMITS"

api GET "/repos/$OWNER/$REPO_NAME"
[ "$API_CODE" = "200" ] || die "repository lookup failed (HTTP $API_CODE)"
CREATED=$(jget created_at)
[ -n "$CREATED" ] || die "could not read repository creation time"
AGE=$(python3 -c '
import datetime, sys
created = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
print(int((datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()))' "$CREATED")
if [ "$AGE" -lt "$MIN_REPO_AGE_SECONDS" ] && [ "$FORCE_PR" -ne 1 ]; then
    HOURS=$(( (MIN_REPO_AGE_SECONDS - AGE + 3599) / 3600 ))
    warn "repository is $((AGE / 3600))h old; awesome-dsh-plugin requires at least 1 day."
    warn "The repository and topics are published. Re-run './publish.sh --pr-only' in ~${HOURS}h,"
    warn "or pass --force-pr to open the PR anyway (the list CI may reject it)."
    write_state
    exit 0
fi
ok "repository age gate passed ($((AGE / 3600))h)"

FORK_REPO="$OWNER/awesome-dsh-plugin"
api GET "/repos/$FORK_REPO"
if [ "$API_CODE" = "404" ]; then
    info "creating fork of $AWESOME_SLUG"
    api POST "/repos/$AWESOME_SLUG/forks" '{"default_branch_only":true}'
    [ "$API_CODE" = "202" ] || [ "$API_CODE" = "200" ] \
        || die "fork request failed (HTTP $API_CODE): $(jget message)"
    ok "fork requested"
else
    [ "$API_CODE" = "200" ] || die "cannot inspect fork (HTTP $API_CODE): $(jget message)"
    ok "fork already exists: https://github.com/$FORK_REPO"
fi

info "waiting for the fork to become available"
for _ in $(seq 1 30); do
    api GET "/repos/$FORK_REPO"
    [ "$API_CODE" = "200" ] && break
    sleep 2
done
[ "$API_CODE" = "200" ] || die "fork did not become available in 60s"

if [ "$PR_MODE" = "api" ]; then
    api_pr
    exit 0
fi

WORK="$TMP/awesome"
info "cloning fork"
git_cred clone --quiet "https://github.com/$FORK_REPO.git" "$WORK" || die "fork clone failed"
cd "$WORK"
git remote add upstream "https://github.com/$AWESOME_SLUG.git"
git_cred fetch --quiet upstream
BASE_BRANCH="main"
git rev-parse --verify --quiet "upstream/main" >/dev/null || BASE_BRANCH="master"
ok "fork cloned (base: upstream/$BASE_BRANCH)"

# Start from a clean copy of upstream so an old fork does not leak into the PR.
BRANCH="add-$REPO_NAME"
git checkout --quiet -B "$BRANCH" "upstream/$BASE_BRANCH"

[ -f contributing.md ] || warn "contributing.md not found in the list repository; using built-in rules"
if [ -f data/categories.yml ] || [ -f data/categories.yaml ]; then
    CAT_FILE=$( [ -f data/categories.yml ] && echo data/categories.yml || echo data/categories.yaml )
    VALID=$(sed -n 's/^[[:space:]]*-\{0,1\}[[:space:]]*id:[[:space:]]*//p' "$CAT_FILE" | tr -d '"' | tr '\n' ' ')
    info "categories from $CAT_FILE: $VALID"
    case " $VALID " in
        *" $CATEGORY "*) ;;
        *) die "category '$CATEGORY' is not in $CAT_FILE; pick one of: $VALID" ;;
    esac
else
    # Fall back to the categories already used by entries.
    USED=$(grep -h '^category:' data/plugins/*.yml 2>/dev/null | sed 's/^category:[[:space:]]*//' | tr -d '"' | sort -u | tr '\n' ' ')
    if [ -n "$USED" ]; then
        info "categories in use: $USED"
        case " $USED " in
            *" $CATEGORY "*) ;;
            *) die "category '$CATEGORY' is not used by any entry; pick one of: $USED (or pass --category)" ;;
        esac
    fi
fi

ENTRY_DIR="data/plugins"
mkdir -p "$ENTRY_DIR"
ENTRY_FILE="$ENTRY_DIR/${OWNER}__${REPO_NAME}.yml"
render_entry "$ENTRY_FILE"
ok "wrote $ENTRY_FILE"
validate_entry "$ENTRY_FILE"

# If the list repository ships a generator for its READMEs, run it: the two
# READMEs must not be edited by hand.
GENERATOR=$(python3 -c '
import json, os
if not os.path.exists("package.json"):
    raise SystemExit
data = json.load(open("package.json"))
scripts = data.get("scripts") or {}
for name, command in scripts.items():
    if any(word in name.lower() for word in ("build", "generat", "sync")) or any(
        word in str(command).lower() for word in ("generate", "build-readme")
    ):
        print(f"{name}\t{command}")
        break
' 2>/dev/null || true)
if [ -n "$GENERATOR" ]; then
    GEN_NAME=${GENERATOR%%$'\t'*}
    info "running list generator: $GEN_NAME"
    if [ -f pnpm-lock.yaml ]; then PM="pnpm"; elif [ -f yarn.lock ]; then PM="yarn"; else PM="npm"; fi
    if [ ! -d node_modules ]; then
        info "installing generator dependencies with $PM"
        case "$PM" in
            pnpm) (pnpm install --frozen-lockfile --ignore-scripts) || warn "pnpm install failed; trying generator anyway" ;;
            yarn) (yarn install --frozen-lockfile --ignore-scripts) || warn "yarn install failed; trying generator anyway" ;;
            npm) (npm ci --ignore-scripts --no-audit --no-fund) || (npm install --ignore-scripts --no-audit --no-fund) || warn "npm install failed; trying generator anyway" ;;
        esac
    fi
    case "$PM" in
        pnpm) pnpm run "$GEN_NAME" || die "README generator failed; refusing to hand-edit generated files" ;;
        yarn) yarn "$GEN_NAME" || die "README generator failed; refusing to hand-edit generated files" ;;
        npm) npm run "$GEN_NAME" || die "README generator failed; refusing to hand-edit generated files" ;;
    esac
else
    warn "no README generator found in the list repository; committing only the entry file"
fi

# Only our entry (plus generator output) may be part of this PR.
CHANGED=$(git status --porcelain | awk '{print $2}' | grep -v -E "^(${ENTRY_FILE//\//\\/}|README[^/]*|README_.*)$" || true)
if [ -n "$CHANGED" ] && [ "${ALLOW_EXTRA_FILES:-0}" != "1" ]; then
    printf '%s\n' "$CHANGED" >&2
    die "unexpected files changed; refusing to open a mixed PR (set ALLOW_EXTRA_FILES=1 to override)"
fi

TITLE=$(sed -n 's/^Title:[[:space:]]*//p' "$ROOT/PR.md" | head -n 1)
BODY=$(sed -n '/^Body:/,$p' "$ROOT/PR.md" | tail -n +2)
[ -n "$TITLE" ] || die "PR.md has no 'Title:' line"

git add -A
if git diff --cached --quiet; then
    info "entry already committed on $BRANCH"
else
    git commit --quiet -m "$TITLE"
    ok "committed entry on $BRANCH"
fi

info "pushing $BRANCH to the fork"
git_cred push --quiet --force-with-lease -u origin "$BRANCH" || die "pushing the fork branch failed"
ok "branch pushed"

# Reuse an existing open PR instead of opening a duplicate.
api GET "/repos/$AWESOME_SLUG/pulls?state=open&head=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$OWNER:$BRANCH")"
if [ "$API_CODE" = "200" ]; then
    PR_URL=$(python3 -c '
import json, sys
pulls = json.load(sys.stdin)
print(pulls[0]["html_url"] if pulls else "")' <<<"$API_BODY")
fi

if [ -n "${PR_URL:-}" ]; then
    ok "open pull request already exists: $PR_URL"
else
    info "opening pull request against $AWESOME_SLUG"
    PAYLOAD="$TMP/pr.json"
    python3 - "$TITLE" "$BODY" "$OWNER" "$BRANCH" "$BASE_BRANCH" > "$PAYLOAD" <<'PY'
import json, sys
title, body, owner, branch, base = sys.argv[1:6]
print(json.dumps({
    "title": title,
    "head": f"{owner}:{branch}",
    "base": base,
    "body": body,
    "maintainer_can_modify": True,
}, ensure_ascii=False))
PY
    api POST "/repos/$AWESOME_SLUG/pulls" "$(cat "$PAYLOAD")"
    [ "$API_CODE" = "201" ] || die "opening the PR failed (HTTP $API_CODE): $(jget message)"
    PR_URL=$(jget html_url)
    ok "pull request opened: $PR_URL"
fi

write_state
printf '\n'
info "done."
info "repository: $REPO_URL"
info "pull request: ${PR_URL:-none}"
info "state: $ROOT/.publish-state.json"
