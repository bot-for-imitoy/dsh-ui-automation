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
#
# Token: read from $GITHUB_TOKEN_FILE (default ~/.dsh/github-token). It is only
# handed to curl through a 0600 netrc file and to git through a 0600 askpass
# script; it is never placed in argv, config, logs or the repository.

set -euo pipefail
umask 077

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_NAME="dsh-ui-automation"
AWESOME_SLUG="awesome-dsh-plugin/awesome-dsh-plugin"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-$HOME/.dsh/github-token}"
CATEGORY="${AWESOME_CATEGORY:-tools}"
MODE="full"
FORCE_PR=0
MIN_COMMITS=10
MIN_REPO_AGE_SECONDS=86400

usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
        --force-pr) FORCE_PR=1; shift ;;
        --category) CATEGORY="${2:?--category needs a value}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

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
{
    printf 'machine api.github.com\n  login x\n  password '
    tr -d '\r\n' < "$TOKEN_FILE"
    printf '\n'
} > "$NETRC"
chmod 600 "$NETRC"

# Askpass: git gets the username and the token from files, never from argv.
cat > "$ASKPASS" <<'ASKPASS_EOF'
#!/bin/sh
case "$1" in
    Username*) printf '%s\n' "${GIT_USER:-x}" ;;
    *) tr -d '\r\n' < "${GIT_TOKEN_FILE:?}" ;;
esac
ASKPASS_EOF
chmod 700 "$ASKPASS"
export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 GIT_TOKEN_FILE="$TOKEN_FILE"

# ---------------------------------------------------------------- helpers
API_CODE=""
API_BODY=""

api() {
    local method="$1" path="$2" body="${3:-}"
    local args=(-sS --netrc-file "$NETRC" -X "$method"
        -H 'Accept: application/vnd.github+json'
        -H 'X-GitHub-Api-Version: 2022-11-28'
        -H 'Content-Type: application/json'
        -o "$RESP_FILE" -w '%{http_code}')
    if [ -n "$body" ]; then
        API_CODE=$(curl "${args[@]}" --data "$body" "https://api.github.com$path") \
            || die "curl failed: $method $path"
    else
        API_CODE=$(curl "${args[@]}" "https://api.github.com$path") \
            || die "curl failed: $method $path"
    fi
    API_BODY=$(cat "$RESP_FILE" 2>/dev/null || true)
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
    python3 - "$ROOT/.publish-state.json" "$OWNER" "$REPO_URL" "${PR_URL:-}" "$CATEGORY" <<'PY'
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

# ---------------------------------------------------------------- preflight
info "token file: $TOKEN_FILE"
NET_CODE=$(curl -m 12 -sS -o /dev/null -w '%{http_code}' https://api.github.com/ 2>/dev/null || true)
case "$NET_CODE" in
    200|401|403) ok "api.github.com reachable (HTTP $NET_CODE)" ;;
    *)
        die "api.github.com is not reachable (got '$NET_CODE').
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
ok "authenticated as $OWNER (token scope: $(jget scopes 2>/dev/null || echo 'unknown'))"

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
sed "s/__OWNER__/$OWNER/g" "$ROOT/awesome-entry.yml" > "$ENTRY_FILE"
ok "wrote $ENTRY_FILE"

# Validate the entry before committing: url must match, description.en must be
# one sentence ending with a period, and every required field must be present.
python3 - "$ENTRY_FILE" "$OWNER" "$REPO_NAME" <<'PY'
import sys

try:
    import yaml
except ImportError:
    print("! PyYAML not installed; skipping YAML validation")
    sys.exit(0)

path, owner, repo = sys.argv[1:4]
with open(path, encoding="utf-8") as handle:
    entry = yaml.safe_load(handle)

expected = f"https://github.com/{owner}/{repo}"
problems = []
if entry.get("url") != expected:
    problems.append(f"url must be {expected}")
if entry.get("name") != f"{owner}/{repo}":
    problems.append(f"name must be {owner}/{repo}")
if not entry.get("category"):
    problems.append("category is missing")
en = (entry.get("description") or {}).get("en", "")
if not en.strip().endswith("."):
    problems.append("description.en must end with a period")
if "\n" in en.strip():
    problems.append("description.en must be a single line")
if problems:
    print("✗ entry validation failed:")
    for problem in problems:
        print(f"  - {problem}")
    sys.exit(1)
print("✓ entry validated (url, name, category, single-line description.en)")
PY

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
