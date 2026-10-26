# Server security

What the application protects by itself, what the server has to provide, and the commands to check and fix the server. Nothing here replaces a penetration test.

## 1. Check the server (read-only)

From your computer, without copying anything to the server:

```bash
ssh root@YOUR_SERVER 'bash -s -- check' < scripts/server-security.sh
```

It prints OK / WARN / FAIL and changes nothing. It looks at: SSH settings and keys, a firewall, fail2ban, what listens on the network (and which Docker containers publish a port to everyone),
the permissions of `.env` and the backups folder, whether `ENCRYPTION_KEY` is the published example, automatic security updates, and HTTPS in nginx. It exits 1 on any FAIL.

Fix every FAIL. WARNs are worth reading; each says what to do.

## 2. SSH: keys only, no passwords

Logging in as root with a password lets anyone on the internet keep guessing it. Switch to a key:

1. On your computer, if you have no key: `ssh-keygen -t ed25519`
2. Put it on the server: `ssh-copy-id root@YOUR_SERVER` (enter the password one last time)
3. Prove it works: `ssh root@YOUR_SERVER` should log in without asking for the password.
4. Turn passwords off:

```bash
ssh root@YOUR_SERVER 'bash -s -- harden-ssh --yes' < scripts/server-security.sh
```

It refuses unless root already has a key, checks the settings with `sshd -t`, confirms with `sshd -T` that nothing else overrides them (cloud images often ship a file that turns passwords back on), and undoes itself if so.
**Before you close your session, open a second terminal and log in again.** To undo: `rm /etc/ssh/sshd_config.d/00-cloudbuilder-hardening.conf && systemctl reload ssh`.

## 3. Firewall and brute-force protection

Allow SSH first, or you lock yourself out:

```bash
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
apt install -y fail2ban      # bans addresses that keep guessing
apt install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
```

The app port (3100) and the database (5432) must not be reachable from outside: bind the database container to `127.0.0.1` (`-p 127.0.0.1:5432:5432`) and let nginx be the only way in.

## 4. Secrets

- `.env` must be `chmod 600` and owned by root. The backups folder (`/root/cloudbuilder-backups`) must be `chmod 700`: it holds a copy of `.env` and a database dump.
- `ENCRYPTION_KEY` must be your own (`npm run credentials:new-key`), never the example in `.env.example`: with the example, anyone can decrypt the stored cloud credentials. The app refuses to start in production with a weak, example or duplicated key.
- Anyone with root on the server can read the key and the database, so protect root (sections 2 and 3) above all.
- Revoke an API key you pasted anywhere (chat, tickets, shell history) and make a new one.

## 5. Run the app as a normal user (recommended)

The pm2 processes run as root, so a flaw in the app would own the machine. Create a user for it, give it the app folder and `.env`, and start pm2 as that user. This is a larger change (paths, pm2 startup, the deploy script's `DEPLOY_HOST`), so do it deliberately and run `check` after.

## 6. What the application does by itself

- Session cookies are `httpOnly`, `Secure` in production and `SameSite=Lax`. State-changing API requests that the browser marks as coming from another website are refused (`proxy.ts`); requests with their own API key or bearer token are not affected. A sibling subdomain can be allowed with `CLOUDBUILDER_ALLOWED_ORIGINS` (comma separated).
- Security headers: a content security policy, no framing, no content sniffing, a referrer policy, a permissions policy, and HSTS in production.
- Sign-in has rate limits and lockout; Deploy, the AI Generator and cloud accounts are limited to `RESTRICTED_FEATURES_ALLOWED_EMAILS`; API keys are stored as hashes and are read-only.
- Cloud credentials are encrypted at rest (AES-256-GCM). Terraform is generated from sanitized input, limited to a fixed list of resource types, and a plan that destroys, opens admin ports or creates admin policies is refused. Approvals are tied to the exact plan.
- Code taken from a Git repository: https only, allow-listed hosts, no internal addresses, no hooks, tokens never stored.
- CI scans the generated Terraform, Dockerfiles and manifests with Trivy, and fails on a high or critical advisory in a production dependency (`security/audit-policy.json` lists the accepted ones, each with a reason).
