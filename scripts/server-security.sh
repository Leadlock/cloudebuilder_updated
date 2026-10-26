#!/usr/bin/env bash
# Looks at how safe the server is, and (only when asked) closes the most common hole: logging in over SSH as root with a password.
#
# Run it ON the server, as root. From your computer, without copying anything there:
#   ssh root@SERVER 'bash -s -- check' < scripts/server-security.sh              read-only: changes nothing
#   ssh root@SERVER 'bash -s -- harden-ssh --yes' < scripts/server-security.sh   key-only SSH login (see below)
#
# check        reports OK / WARN / FAIL for: SSH settings, SSH keys, firewall, fail2ban, what listens on the network, Docker ports, the permissions of the
#              secrets files, whether the encryption key is the published example, automatic security updates, and TLS in nginx. It exits 1 on any FAIL.
# harden-ssh   writes /etc/ssh/sshd_config.d/00-cloudbuilder-hardening.conf (root may log in with a key only; no passwords; 4 tries) and reloads sshd.
#              It REFUSES unless root already has an authorized key (otherwise you would lock yourself out), checks the configuration with `sshd -t` first,
#              confirms the result with `sshd -T`, and undoes itself if the setting did not take effect. Your current session stays open: before you close
#              it, log in again from a second terminal to prove the key works. To undo: delete that file and reload sshd.
set -uo pipefail

APP_DIR="${APP_DIR:-/root/CloudCraft}"
BACKUP_DIR="${BACKUP_DIR:-/root/cloudbuilder-backups}"
DROPIN="${SSHD_DROPIN:-/etc/ssh/sshd_config.d/00-cloudbuilder-hardening.conf}"
SSHD_MAIN="${SSHD_CONFIG:-/etc/ssh/sshd_config}"
AUTHORIZED_KEYS="${AUTHORIZED_KEYS_FILE:-/root/.ssh/authorized_keys}"
FAILS=0 WARNS=0
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
head_() { printf '\n%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
sshd_value() { sshd -T 2>/dev/null | awk -v k="$1" '$1 == k { print $2; exit }'; }

reload_sshd() {
  if have systemctl && systemctl list-unit-files 2>/dev/null | grep -qE '^(ssh|sshd)\.service'; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null
  elif have service; then service ssh reload 2>/dev/null || service sshd reload 2>/dev/null
  else return 1; fi
}

cmd_check() {
  [ "$(id -u)" = 0 ] || echo "  (not root: some checks cannot see everything)"

  head_ "SSH"
  if have sshd; then
    local root pw kbd tries
    root="$(sshd_value permitrootlogin)"; pw="$(sshd_value passwordauthentication)"; kbd="$(sshd_value kbdinteractiveauthentication)"; tries="$(sshd_value maxauthtries)"
    [ -z "$root" ] && warn "could not read the SSH settings (run as root)" || {
      case "$root" in
        yes) [ "$pw" = yes ] && fail "root can log in over SSH with a PASSWORD: anyone on the internet can try to guess it. Run: harden-ssh --yes (after adding your key)" || warn "root can log in over SSH (with a key only, passwords are off)";;
        prohibit-password|without-password) ok "root may log in with a key only";;
        no|forced-commands-only) ok "root cannot log in over SSH (permitrootlogin $root)";;
        *) warn "permitrootlogin is '$root'";;
      esac
      [ "$pw" = no ] && ok "password login is off" || { [ "$root" = yes ] || warn "password login is on for ordinary users (passwordauthentication $pw)"; }
      [ "$kbd" = yes ] && warn "keyboard-interactive login is on: it can be a second way to type a password"
      [ -n "$tries" ] && { [ "$tries" -le 4 ] 2>/dev/null && ok "at most $tries tries per connection" || warn "maxauthtries is $tries (4 or fewer is better)"; }
    }
  else warn "sshd is not installed here (or not on the PATH)"; fi
  if [ -s "$AUTHORIZED_KEYS" ]; then ok "root has $(grep -cE '^(ssh-|ecdsa-|sk-)' "$AUTHORIZED_KEYS" 2>/dev/null || echo 0) SSH key(s) in $AUTHORIZED_KEYS"; else warn "root has no SSH key yet ($AUTHORIZED_KEYS): add one before turning passwords off"; fi

  head_ "Firewall and brute-force protection"
  if have ufw && ufw status 2>/dev/null | grep -q "Status: active"; then ok "ufw is active"
  elif have nft && nft list ruleset 2>/dev/null | grep -q "hook input"; then ok "an nftables firewall has input rules"
  elif have iptables && iptables -S INPUT 2>/dev/null | grep -qE "^-P INPUT (DROP|REJECT)|^-A INPUT"; then ok "iptables has input rules"
  else warn "no firewall found: every port a program opens is reachable. Suggested: ufw default deny incoming; ufw allow 22,80,443/tcp; ufw enable (allow 22 FIRST)"; fi
  if have fail2ban-client && fail2ban-client status 2>/dev/null | grep -q "sshd"; then ok "fail2ban watches SSH"; else warn "fail2ban is not watching SSH (it bans addresses that keep guessing passwords): apt install fail2ban"; fi

  head_ "What listens on the network"
  if have ss; then
    local open
    open="$(ss -H -tuln 2>/dev/null | awk '{ n=split($5,a,":"); port=a[n]; addr=substr($5,1,length($5)-length(port)-1); if (addr=="0.0.0.0" || addr=="*" || addr=="[::]" || addr=="::") print $1" "port }' | sort -u)"
    if [ -z "$open" ]; then ok "nothing listens on all interfaces"; else
      while read -r proto port; do
        case "$port" in
          22) ok "$proto $port (SSH) listens on all interfaces";;
          80|443) ok "$proto $port (web) listens on all interfaces";;
          3100|3000|5432|3306|6379|27017|5672|9200|8080) fail "$proto $port listens on ALL interfaces: it should only be reachable from this machine (127.0.0.1) or through nginx";;
          *) warn "$proto $port listens on all interfaces: is it meant to be public?";;
        esac
      done <<< "$open"
    fi
  else warn "ss is not installed: cannot list listening ports"; fi
  if have docker; then
    local pub
    pub="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '(0\.0\.0\.0|\[::\]):[0-9]+->' || true)"
    if [ -z "$pub" ]; then ok "no Docker container publishes a port to the whole network"; else echo "$pub" | while read -r line; do fail "Docker publishes to everyone: $line (bind it to 127.0.0.1: -p 127.0.0.1:5432:5432)"; done; fi
  fi

  head_ "Secrets on disk"
  if [ -f "$APP_DIR/.env" ]; then
    local mode owner; mode="$(stat -c '%a' "$APP_DIR/.env" 2>/dev/null || stat -f '%Lp' "$APP_DIR/.env")"; owner="$(stat -c '%U' "$APP_DIR/.env" 2>/dev/null || stat -f '%Su' "$APP_DIR/.env")"
    [ "$owner" = root ] && [ "${mode: -2}" = "00" ] && ok ".env is private ($mode, $owner)" || fail ".env is readable by others ($mode, owner $owner): chmod 600 $APP_DIR/.env"
    local key example; key="$(grep -E '^ENCRYPTION_KEY=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d "\"' ")"
    example="$(grep -E '^ENCRYPTION_KEY=' "$APP_DIR/.env.example" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"' ")"
    if [ -z "$key" ]; then fail "ENCRYPTION_KEY is not set in .env"
    elif [ -n "$example" ] && [ "$key" = "$example" ]; then fail "ENCRYPTION_KEY is the PUBLISHED EXAMPLE: anyone can decrypt the stored cloud credentials. Make your own: npm run credentials:new-key (then rotate: see .env.example)"
    elif [ "${#key}" -ne 64 ]; then warn "ENCRYPTION_KEY is not 64 hex characters"
    else ok "ENCRYPTION_KEY is set and is not the published example"; fi
    grep -qE '^CLOUDBUILDER_ALLOW_TEST_AUTH_HEADERS=1' "$APP_DIR/.env" && fail "CLOUDBUILDER_ALLOW_TEST_AUTH_HEADERS=1 lets anyone log in as any user: remove it"
  else warn "no .env at $APP_DIR (set APP_DIR if the app is elsewhere)"; fi
  if [ -d "$BACKUP_DIR" ]; then
    local bmode; bmode="$(stat -c '%a' "$BACKUP_DIR" 2>/dev/null || stat -f '%Lp' "$BACKUP_DIR")"
    [ "${bmode: -2}" = "00" ] && ok "backups folder is private ($bmode): it holds .env and a database dump" || fail "backups folder is readable by others ($bmode): chmod 700 $BACKUP_DIR"
  fi

  head_ "Updates and the web server"
  if [ -f /etc/apt/apt.conf.d/20auto-upgrades ] && grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then ok "automatic security updates are on"; else warn "automatic security updates are off: apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"; fi
  if have apt; then local n; n="$(apt list --upgradable 2>/dev/null | grep -ci security || true)"; [ "${n:-0}" -eq 0 ] && ok "no security updates waiting" || warn "$n security update(s) waiting: apt update && apt upgrade"; fi
  if have nginx; then
    local conf; conf="$(nginx -T 2>/dev/null)"
    echo "$conf" | grep -qE 'listen[^;]*443[^;]*ssl|ssl_certificate ' && ok "nginx serves HTTPS" || fail "nginx does not serve HTTPS: logins and sessions cross the internet in clear text"
    echo "$conf" | grep -qE 'return 30[12] https|rewrite .* https' && ok "plain HTTP is redirected to HTTPS" || warn "no HTTP to HTTPS redirect found in nginx"
    echo "$conf" | grep -qE 'server_tokens\s+off' && ok "nginx hides its version" || warn "nginx shows its version (server_tokens off;)"
    echo "$conf" | grep -qE 'ssl_protocols[^;]*TLSv1(\.0|\.1)?[ ;]' && warn "nginx allows TLS 1.0/1.1" || ok "no old TLS versions enabled in nginx"
  else warn "nginx is not installed (or not on the PATH): how is the app reached?"; fi
  if have pm2; then
    local runas; runas="$(ps -o user= -C node 2>/dev/null | sort -u | tr '\n' ' ')"
    [ "$runas" = "root " ] && warn "the app runs as root: a flaw in it would own the machine. Better: a dedicated user (see docs/SERVER_SECURITY.md)" || ok "app processes run as: ${runas:-unknown}"
  fi

  printf '\n%s FAIL, %s WARN\n' "$FAILS" "$WARNS"
  [ "$FAILS" -eq 0 ]
}

cmd_harden_ssh() {
  local yes=0; for a in "$@"; do [ "$a" = "--yes" ] && yes=1; done
  [ "$(id -u)" = 0 ] || { echo "Run as root."; return 1; }
  have sshd || { echo "sshd is not installed here."; return 1; }
  [ "$yes" = 1 ] || { echo "This turns off SSH password login for everyone and lets root in with a key only. Add --yes to do it."; return 1; }
  # Never lock the person out: a key must already be there.
  if ! grep -qE '^(ssh-|ecdsa-|sk-)' "$AUTHORIZED_KEYS" 2>/dev/null; then
    echo "REFUSED: root has no SSH key in $AUTHORIZED_KEYS, so turning passwords off would lock you out."
    echo "On your computer:  ssh-copy-id root@THIS_SERVER   (then log in with the key to prove it works, and run this again)"
    return 1
  fi
  # A drop-in only counts if the main file includes the folder.
  if ! grep -qE '^\s*Include\s+.*sshd_config\.d' "$SSHD_MAIN" 2>/dev/null; then
    echo "REFUSED: $SSHD_MAIN does not include /etc/ssh/sshd_config.d/*.conf, so a drop-in would do nothing. Edit the main file by hand: PasswordAuthentication no, PermitRootLogin prohibit-password."
    return 1
  fi
  local backup=""; [ -f "$DROPIN" ] && { backup="$(mktemp)"; cp "$DROPIN" "$backup"; }
  mkdir -p "$(dirname "$DROPIN")"
  # Named 00- so it is read first: sshd keeps the FIRST value it sees, and cloud images often ship a 50-cloud-init.conf that turns passwords on.
  cat > "$DROPIN" <<CONF
# Written by CloudBuilder's scripts/server-security.sh harden-ssh. To undo: delete this file and reload sshd.
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 4
LoginGraceTime 30
X11Forwarding no
CONF
  chmod 644 "$DROPIN"
  undo() { if [ -n "$backup" ]; then cp "$backup" "$DROPIN"; else rm -f "$DROPIN"; fi; }
  if ! sshd -t 2>/tmp/cb-sshd-test.err; then echo "REFUSED: sshd rejects the new settings ($(head -c 200 /tmp/cb-sshd-test.err)); nothing was changed."; undo; return 1; fi
  # sshd prints "prohibit-password" as "without-password" in some versions: they mean the same.
  local eff_root; eff_root="$(sshd_value permitrootlogin)"
  if [ "$(sshd_value passwordauthentication)" != no ] || { [ "$eff_root" != prohibit-password ] && [ "$eff_root" != without-password ]; }; then
    echo "REFUSED: another setting overrides this one (sshd -T says password=$(sshd_value passwordauthentication), root=$(sshd_value permitrootlogin)); nothing was changed. Look in /etc/ssh/sshd_config.d/ and $SSHD_MAIN."
    undo; return 1
  fi
  if reload_sshd; then echo "Done: SSH now accepts keys only (root: key only). Your open session stays connected."; else echo "The settings are written and valid, but sshd could not be reloaded from here: reload it yourself (systemctl reload ssh)."; fi
  echo "NOW, before closing this session: open a SECOND terminal and run  ssh root@THIS_SERVER  to prove the key works."
  echo "To undo: rm $DROPIN && systemctl reload ssh"
}

case "${1:-check}" in
  check) cmd_check ;;
  harden-ssh) shift; cmd_harden_ssh "$@" ;;
  *) echo "usage: server-security.sh check | harden-ssh --yes"; exit 2 ;;
esac
