#!/usr/bin/env bash
# Redeploy CloudBuilder to the server from your own computer.
#
#   scripts/deploy.sh                 deploy what is on origin/main (asks you to confirm)
#   scripts/deploy.sh --dry-run       show what would be sent; changes nothing on the server
#   scripts/deploy.sh --rollback      put the newest backup back on the server
#   scripts/deploy.sh --status        show what is running there and the backups it keeps
#
# Options: --yes (no question), --allow-unpushed (deploy a commit that is not on origin/main), --ignore-ci (deploy although CI is not green)
# Settings (environment): DEPLOY_HOST (default root@72.61.244.75), DEPLOY_DIR (default /root/CloudCraft)
#
# What it does: checks your copy is clean and equal to origin/main and CI is green; backs up the running version on the server; copies the new
# source (never .env, never node_modules); installs, builds, restarts only the CloudBuilder processes and checks they are healthy and stay up;
# and goes back to the backup by itself if anything fails. The server's own .env (including the access lock) is never touched.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@72.61.244.75}"
DIR="${DEPLOY_DIR:-/root/CloudCraft}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
REMOTE_SH="$HERE/deploy/remote.sh"

DRY=0 YES=0 ROLLBACK=0 STATUS=0 UNPUSHED=0 IGNORE_CI=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;; --yes) YES=1 ;; --rollback) ROLLBACK=1 ;; --status) STATUS=1 ;;
    --allow-unpushed) UNPUSHED=1 ;; --ignore-ci) IGNORE_CI=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# One connection for every step, so a password is asked once.
SOCK="/tmp/ccd-$$"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$SOCK" -o ControlPersist=300 -o ServerAliveInterval=15 -o StrictHostKeyChecking=accept-new)
remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
# Runs remote.sh on the server with the folder from DEPLOY_DIR (the script is sent on stdin: nothing has to be installed there first).
run_remote() { ssh "${SSH_OPTS[@]}" "$HOST" "APP_DIR='$DIR' bash -s -- $*" < "$REMOTE_SH"; }
cleanup() { ssh "${SSH_OPTS[@]}" -O exit "$HOST" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ "$STATUS" = 1 ]; then
  say "Server $HOST ($DIR)"
  remote "cd '$DIR' && echo \"running commit: \$(cat .deployed-commit 2>/dev/null || echo unknown)\" && pm2 status 2>/dev/null | head -20; ls -1t /root/cloudcraft-backups/*.tgz 2>/dev/null | head -5"
  exit 0
fi

if [ "$ROLLBACK" = 1 ]; then
  [ "$YES" = 1 ] || { read -r -p "Put the newest backup back on $HOST? [y/N] " ans; [ "$ans" = y ] || [ "$ans" = Y ] || die "cancelled."; }
  run_remote rollback
  exit 0
fi

cd "$REPO"
[ -f package.json ] && [ -f "$REMOTE_SH" ] || die "run this from the CloudBuilder repository."

# 1. Only a clean, published, green commit goes to the server.
[ -z "$(git status --porcelain)" ] || die "you have uncommitted changes. Commit or stash them: what is deployed must be a commit anyone can get back."
git fetch -q origin
COMMIT="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short HEAD)"
if [ "$UNPUSHED" != 1 ]; then
  [ "$COMMIT" = "$(git rev-parse origin/main)" ] || die "HEAD ($SHORT) is not origin/main ($(git rev-parse --short origin/main)). Check out main and pull, or pass --allow-unpushed."
fi
if [ "$IGNORE_CI" != 1 ]; then
  if command -v gh >/dev/null && CI="$(gh run list --commit "$COMMIT" --workflow ci --json status,conclusion --jq '[.[]|select(.status=="completed")]|first|.conclusion // "none"' 2>/dev/null)"; then
    case "$CI" in
      success) say "CI is green for $SHORT." ;;
      none|"") die "no finished CI run for $SHORT yet. Wait for it, or pass --ignore-ci." ;;
      *) die "CI is '$CI' for $SHORT. Fix it first, or pass --ignore-ci." ;;
    esac
  else
    echo "Could not read CI status (is the GitHub CLI logged in? 'gh auth login'). Continuing without that check."
  fi
fi

# Only files git tracks are sent (so nothing local, ignored or secret can leave this computer), and never anything the server owns.
# --checksum compares contents, not size and time: a changed file that happens to keep its size and timestamp is still sent.
send() { git ls-files -z | rsync "$@" --checksum --from0 --files-from=- --exclude '.env*' --exclude .deployed-commit --exclude .installed-lock-hash -e "ssh ${SSH_OPTS[*]}" ./ "$HOST:$DIR/"; }

if [ "$DRY" = 1 ]; then
  say "DRY RUN: nothing on the server changes. Files that would be sent to $HOST:$DIR for $SHORT:"
  send -avn | grep -v '/$' | head -60
  exit 0
fi

say "Deploy $SHORT ($(git log -1 --format=%s)) to $HOST:$DIR"
if [ "$YES" != 1 ]; then read -r -p "Continue? [y/N] " ans; [ "$ans" = y ] || [ "$ans" = Y ] || die "cancelled."; fi

# 2. Checks on the server, then a backup.
say "1/3 Checking the server and backing up the running version"
run_remote prepare

# 3. Copy the source. Never deletes anything there; never touches .env.
say "2/3 Copying the new source"
send -a

# 4. Build, restart, verify (and go back by itself on a failure).
say "3/3 Installing, building and restarting (this takes a few minutes)"
if run_remote activate "$COMMIT"; then
  say "Deployed $SHORT. Check the site, then sign in as someone who must NOT have access to Deploy and see 'Not accessible'."
else
  die "the deploy failed and the previous version was put back (see above). Nothing to clean up."
fi
