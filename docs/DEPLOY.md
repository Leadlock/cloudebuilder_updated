# Deploying CloudBuilder

One command, from your own computer, in the repository, on `main`:

```bash
scripts/deploy.sh --dry-run    # shows what would be sent; changes nothing
scripts/deploy.sh              # deploys origin/main after you confirm
scripts/deploy.sh --status     # what is running there, and the backups it keeps
scripts/deploy.sh --rollback   # puts the newest backup back
```

Settings (environment): `DEPLOY_HOST` (default `root@72.61.244.75`) and `DEPLOY_DIR` (default `/root/CloudCraft`).
Needs `ssh` and `rsync` here, and `rsync`, `python3`, `npm` and `pm2` on the server. `gh` (GitHub CLI, logged in) lets it check CI.

## What it refuses to do
- Deploy with uncommitted changes, or a commit that is not `origin/main` (`--allow-unpushed` overrides).
- Deploy when CI for that commit is not green (`--ignore-ci` overrides).
- Deploy to a server that has no `.env`: the server's `.env` holds the access lock (`RESTRICTED_FEATURES_ALLOWED_EMAILS`, `SUPER_ADMIN_EMAILS`). It is never copied, overwritten or deleted.
- Send anything git does not track (local files, `.env*`, `node_modules`).

## The server refuses to start without the access lock
In production CloudBuilder will not start unless `RESTRICTED_FEATURES_ALLOWED_EMAILS` is set in the server's `.env` (who may use Deploy, the AI Generator and Cloud Accounts). Only a value of `RESTRICTED_FEATURES_OPEN_TO_ALL=1` opens them to everyone, on purpose. If a deploy ever lands on a server without the lock, the processes exit, the health check fails and the deploy rolls back by itself. A missing `SUPER_ADMIN_EMAILS` only prints a warning.

## What it does
1. **Checks the server** (folder, `.env`, free disk, tools, processes) and **backs up** the running version: the source (as `/root/cloudbuilder-backups/<time>.tgz`, only root can read it) and a copy of the build. The newest 5 source backups and 2 builds are kept.
2. **Copies** the tracked files (compared by content, nothing is deleted on the server).
3. **Installs** only when `package-lock.json` changed, **builds**, **restarts only** `cloudcraft-web`, `cloudcraft-discovery` and `cloudcraft-tf-apply` (never the other apps on the server), then waits for the site to answer on port 3100 and for the processes to stay up without restarting.
4. If anything fails it **goes back to the backup by itself**, restarts, and says so. The commit that is running is in `/root/CloudCraft/.deployed-commit`.

## After a deploy
Open the site. Sign in as someone who must **not** have access to Deploy, AI Generator and Cloud Accounts and check they see "Not accessible".

## How it is tested
`__tests__/deployRemote.test.ts` runs the server part for real in a temporary folder (good deploy, failed build, failed install, site not answering, crash loop, rollback, missing `.env`, concurrent deploy, backup pruning). `__tests__/deployScript.test.ts` runs the whole command against a throwaway repository. Neither needs a server.

## Architecture templates in the database
The Templates gallery's built-in templates are written to the `architectureTemplate` table from the code (252 of them, about 2.6 MB): when the server starts, the first time `/api/architecture-templates` is asked for them, and with `npm run templates:sync`. The sync adds new ones, updates changed ones and removes ones that left the code; running it again changes nothing. An organization's own templates ("Save the open project as a template" in the gallery) are rows of the same table with that organization's id, and are never touched by the sync.
After a deploy that includes the migration `add_architecture_templates`: `npm run db:migrate` on the server (the server also writes the built-in rows by itself when it starts). The gallery still shows the built-in templates from the code if the database cannot be reached.

## Read-only API keys for the templates
An administrator makes a key in the Templates gallery ("API keys for other systems"): a name, which templates it may read (the built-in ones, the organization's own, or both) and when it expires. The key (`cb_` and 43 characters) is shown once; only its SHA-256 hash is stored in the `apiKey` table (migration `add_api_keys`). Revoking it stops it at once.
Another system reads with `Authorization: Bearer cb_…` (or `X-API-Key`):
```
GET /api/public/templates                      the list (descriptive fields)
GET /api/public/templates?graphs=1             a full export, with every template's resources and connections
GET /api/public/templates?provider=aws&category=Custom
GET /api/public/templates/<id>                 one template with its graph
```
A key reads nothing else, and every bad key (none, malformed, unknown, revoked, expired) gets the same 401. Failed attempts are limited to 30 a minute per address, and a working key to 120 a minute. After a deploy that includes this, run `npm run db:migrate` on the server.

