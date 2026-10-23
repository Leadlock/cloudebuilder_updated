#!/usr/bin/env bash
# Runs ON THE SERVER (scripts/deploy.sh sends it there over ssh; nothing has to be installed first).
#   remote.sh prepare             checks the server is ready, then backs up the running version (source, build and database)
#   remote.sh activate <commit>   installs, builds and restarts the new version; goes back to the backup by itself if anything fails
#   remote.sh rollback            puts the newest backup back and restarts
# Every setting can be overridden by an environment variable (the tests do, to run this without a real server).
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/root/CloudCraft}"
BACKUP_DIR="${BACKUP_DIR:-/root/cloudbuilder-backups}"
PM2_APPS="${PM2_APPS:-cloudcraft-web cloudcraft-discovery cloudcraft-tf-apply}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3100}"
HEALTH_WAIT="${HEALTH_WAIT:-90}"        # seconds to wait for the site to answer
STABLE_WAIT="${STABLE_WAIT:-10}"        # seconds the processes must stay up without restarting
KEEP_BACKUPS="${KEEP_BACKUPS:-1}"
KEEP_BUILDS="${KEEP_BUILDS:-1}"         # backups that also keep a copy of the build (large)
KEEP_DB_BACKUPS="${KEEP_DB_BACKUPS:-1}"  # database dumps kept (the one just taken replaces the previous one)
DB_CONTAINER="${DB_CONTAINER:-cloudcraft-pg}"
DOCKER="${DOCKER_BIN:-docker}"
PG_DUMP="${PG_DUMP_BIN:-pg_dump}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
NODE_MEM="${NODE_MEM:-4096}"
NPM="${NPM_BIN:-npm}"
PM2="${PM2_BIN:-pm2}"
CURL="${CURL_BIN:-curl}"
RSYNC="${RSYNC_BIN:-rsync}"

say()  { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] WARNING: %s\n' "$*" >&2; }
die()  { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

file_hash() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

app_parent() { dirname "$APP_DIR"; }
app_base()   { basename "$APP_DIR"; }

healthy() { [ "$("$CURL" -s -o /dev/null -m 5 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)" = "200" ]; }

wait_healthy() {
  local waited=0
  while [ "$waited" -lt "$HEALTH_WAIT" ]; do
    if healthy; then return 0; fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

# "name restarts" for every pm2 process we manage; fails when one is not online.
pm2_state() {
  local json
  json="$("$PM2" jlist 2>/dev/null)" || { echo "pm2 NOT-RUNNING"; return 1; }
  python3 -c '
import json, sys
want = sys.argv[1].split()
procs = {p["name"]: p["pm2_env"] for p in json.loads(sys.stdin.read())}
bad = False
for name in want:
    e = procs.get(name)
    if e is None or e.get("status") != "online":
        print(name, "NOT-ONLINE"); bad = True
    else:
        print(name, e.get("restart_time", 0))
sys.exit(1 if bad else 0)
' "$PM2_APPS" <<<"$json"
}

stable() {
  local before after
  before="$(pm2_state)" || { warn "a process is not online: $before"; return 1; }
  sleep "$STABLE_WAIT"
  after="$(pm2_state)" || { warn "a process stopped: $after"; return 1; }
  [ "$before" = "$after" ] || { warn "a process restarted by itself (crash loop?): before=[$before] after=[$after]"; return 1; }
}

restart_apps() {
  # shellcheck disable=SC2086
  "$PM2" restart $PM2_APPS --update-env >/dev/null
}

lock() {
  mkdir -p "$BACKUP_DIR"
  mkdir "$BACKUP_DIR/.deploy.lock" 2>/dev/null || die "another deploy is running (remove $BACKUP_DIR/.deploy.lock if you are sure it is not)."
  trap 'rmdir "$BACKUP_DIR/.deploy.lock" 2>/dev/null || true' EXIT
}

latest_backup() { [ -f "$BACKUP_DIR/latest" ] && cat "$BACKUP_DIR/latest" || true; }

restore_backup() {
  local id="$1"
  local tgz="$BACKUP_DIR/$id.tgz"
  [ -f "$tgz" ] || die "backup $tgz not found."
  say "restoring the source from $tgz"
  tar xzf "$tgz" -C "$(app_parent)"
  if [ -d "$BACKUP_DIR/$id.next" ]; then
    say "restoring the previous build"
    rm -rf "$APP_DIR/.next"
    cp -a "$BACKUP_DIR/$id.next" "$APP_DIR/.next"
  else
    warn "no saved build for this backup: the build has to be made again ($NPM run build)."
  fi
}

# Dumps the app's Postgres database (DATABASE_URL in the server's .env) to $BACKUP_DIR/<id>.sql.gz, then removes the older dumps.
# Through the Docker container when it is running (no password on a command line), else with pg_dump on the server. A database that cannot
# be dumped stops the deploy: a backup that silently did not happen is worse than none. No DATABASE_URL means no database to back up.
backup_database() {
  local id="$1" url user db tmp
  url="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')" || true
  if [ -z "$url" ]; then warn "no DATABASE_URL in $APP_DIR/.env: the database is not backed up."; return 0; fi
  tmp="$BACKUP_DIR/$id.sql.gz.part"
  if command -v "$DOCKER" >/dev/null && "$DOCKER" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
    user="$(printf '%s' "$url" | sed -E 's#^[a-z]+://([^:@/]+).*#\1#')"; db="$(printf '%s' "$url" | sed -E 's#^[^?]*/([^/?]+)(\?.*)?$#\1#')"
    say "backing up the database $db from container $DB_CONTAINER to $BACKUP_DIR/$id.sql.gz"
    "$DOCKER" exec "$DB_CONTAINER" pg_dump -U "$user" -d "$db" --no-owner | gzip > "$tmp" || { rm -f "$tmp"; die "the database backup failed (container $DB_CONTAINER). Nothing was changed."; }
  elif command -v "$PG_DUMP" >/dev/null; then
    say "backing up the database to $BACKUP_DIR/$id.sql.gz"
    "$PG_DUMP" --dbname="$url" --no-owner | gzip > "$tmp" || { rm -f "$tmp"; die "the database backup failed. Nothing was changed."; }
  else
    die "cannot back up the database: container $DB_CONTAINER is not running and pg_dump is not installed. Nothing was changed."
  fi
  [ -s "$tmp" ] && gzip -t "$tmp" || { rm -f "$tmp"; die "the database backup is empty or damaged. Nothing was changed."; }
  mv "$tmp" "$BACKUP_DIR/$id.sql.gz"
  local i=0 f
  for f in $(ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null); do i=$((i + 1)); [ "$i" -gt "$KEEP_DB_BACKUPS" ] && rm -f "$f"; done
  say "database backup done. To restore it: gunzip -c $BACKUP_DIR/$id.sql.gz | docker exec -i $DB_CONTAINER psql -U <user> -d <db>"
}

cmd_prepare() {
  [ -d "$APP_DIR" ] || die "$APP_DIR does not exist."
  [ -f "$APP_DIR/package.json" ] || die "$APP_DIR has no package.json: is it the right folder?"
  [ -f "$APP_DIR/.env" ] || die "$APP_DIR/.env is missing: the server's settings (including the access lock) live there. Refusing to deploy without it."
  command -v "$NPM" >/dev/null || die "npm is not installed."
  command -v "$PM2" >/dev/null || die "pm2 is not installed."
  command -v python3 >/dev/null || die "python3 is needed to read pm2's state."
  command -v "$RSYNC" >/dev/null || die "rsync is not installed on the server (the new files are copied with it). Install it: apt install -y rsync"

  local free_mb
  free_mb="$(df -Pk "$APP_DIR" | awk 'NR==2 {print int($4/1024)}')"
  [ "$free_mb" -ge "$MIN_FREE_MB" ] || die "only ${free_mb} MB free on the disk, need $MIN_FREE_MB MB for the backup and the build."

  pm2_state >/dev/null || warn "not every process is online right now: $(pm2_state || true)"
  healthy && say "the site answers now ($HEALTH_URL)" || warn "the site does not answer right now ($HEALTH_URL): a rollback could not prove it was healthy before."

  lock
  local id; id="$(date +%Y%m%d-%H%M%S)"
  backup_database "$id"
  say "backing up to $BACKUP_DIR/$id.tgz (source) and $id.next (build)"
  tar czf "$BACKUP_DIR/$id.tgz" --exclude=node_modules --exclude=.next -C "$(app_parent)" "$(app_base)"
  if [ -d "$APP_DIR/.next" ]; then cp -a "$APP_DIR/.next" "$BACKUP_DIR/$id.next"; fi
  # The commit this backup holds, so a rollback can say what it went back to.
  cp "$APP_DIR/.deployed-commit" "$BACKUP_DIR/$id.commit" 2>/dev/null || echo "unknown" > "$BACKUP_DIR/$id.commit"
  echo "$id" > "$BACKUP_DIR/latest"

  # Keep the newest KEEP_BACKUPS source backups, and the newest KEEP_BUILDS copies of the build.
  local i=0
  for f in $(ls -1t "$BACKUP_DIR"/*.tgz 2>/dev/null); do
    i=$((i + 1)); b="$(basename "$f" .tgz)"
    if [ "$i" -gt "$KEEP_BACKUPS" ]; then rm -f "$f" "$BACKUP_DIR/$b.commit"; rm -rf "$BACKUP_DIR/$b.next"; fi
    if [ "$i" -gt "$KEEP_BUILDS" ]; then rm -rf "$BACKUP_DIR/$b.next"; fi
  done
  say "backup $id done"
}

cmd_activate() {
  local commit="${1:-unknown}"
  [ -f "$BACKUP_DIR/latest" ] || die "no backup yet: run 'prepare' first."
  local id; id="$(latest_backup)"
  lock
  cd "$APP_DIR"

  fail_and_rollback() {
    warn "$1"
    warn "going back to the previous version ($id)"
    restore_backup "$id"
    restart_apps || warn "pm2 restart failed during the rollback"
    if wait_healthy; then say "ROLLED BACK: the previous version is running again."; else warn "the site still does not answer after the rollback: check 'pm2 logs'."; fi
    exit 1
  }

  # Install only when the dependency list changed since the last install.
  local lock_hash; lock_hash="$(file_hash package-lock.json)"
  if [ ! -d node_modules ] || [ "$(cat .installed-lock-hash 2>/dev/null || true)" != "$lock_hash" ]; then
    say "installing dependencies ($NPM ci)"
    "$NPM" ci || fail_and_rollback "npm ci failed."
    echo "$lock_hash" > .installed-lock-hash
  else
    say "dependencies unchanged: skipping npm ci"
  fi

  say "building"
  NODE_OPTIONS="--max-old-space-size=$NODE_MEM" "$NPM" run build || fail_and_rollback "the build failed. (Nothing was restarted.)"

  say "restarting: $PM2_APPS"
  restart_apps || fail_and_rollback "pm2 could not restart the processes."
  wait_healthy || fail_and_rollback "the site did not answer at $HEALTH_URL within ${HEALTH_WAIT}s."
  stable || fail_and_rollback "a process is not staying up."

  echo "$commit" > .deployed-commit
  say "DONE: $commit is running and healthy."
}

cmd_rollback() {
  local id; id="$(latest_backup)"
  [ -n "$id" ] || die "no backup to go back to."
  lock
  say "going back to backup $id (commit $(cat "$BACKUP_DIR/$id.commit" 2>/dev/null || echo unknown))"
  restore_backup "$id"
  restart_apps
  wait_healthy && stable && say "ROLLED BACK: running again." || die "rolled back, but the site is not healthy: check 'pm2 logs'."
}

case "${1:-}" in
  prepare)  cmd_prepare ;;
  activate) shift; cmd_activate "$@" ;;
  rollback) cmd_rollback ;;
  *) die "usage: remote.sh prepare | activate <commit> | rollback" ;;
esac
