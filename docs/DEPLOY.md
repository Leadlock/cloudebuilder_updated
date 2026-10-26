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
  CI runs on pull requests and on pushes to `main`, not on every branch push. To deploy a branch commit, open a pull request for it (its run is the one the script reads), or pass `--ignore-ci`.
- Deploy to a server that has no `.env`: the server's `.env` holds the access lock (`RESTRICTED_FEATURES_ALLOWED_EMAILS`, `SUPER_ADMIN_EMAILS`). It is never copied, overwritten or deleted.
- Send anything git does not track (local files, `.env*`, `node_modules`).

## The server refuses to start without the access lock
In production CloudBuilder will not start unless `RESTRICTED_FEATURES_ALLOWED_EMAILS` is set in the server's `.env` (who may use Deploy, the AI Generator and Cloud Accounts). Only a value of `RESTRICTED_FEATURES_OPEN_TO_ALL=1` opens them to everyone, on purpose. If a deploy ever lands on a server without the lock, the processes exit, the health check fails and the deploy rolls back by itself. A missing `SUPER_ADMIN_EMAILS` only prints a warning.

## What it does
1. **Checks the server** (folder, `.env`, free disk, tools, processes) and **backs up** the running version: the source (as `/root/cloudbuilder-backups/<time>.tgz`, only root can read it) and a copy of the build. Only the newest backup is kept: the one just taken replaces the previous one (set `KEEP_BACKUPS` and `KEEP_BUILDS` on the server to keep more). The database is dumped too (`<time>.sql.gz`, from the `cloudcraft-pg` container or with `pg_dump`) and only the newest dump is kept (`KEEP_DB_BACKUPS`); if it cannot be dumped the deploy stops before changing anything. A rollback restores the code only, never the database: restore a dump by hand (the command is printed during the deploy).
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
Only the people listed in `CLOUDBUILDER_API_KEY_MANAGERS` (for example `ajinkya@neozaar.com`; when it is not set, the `RESTRICTED_FEATURES_ALLOWED_EMAILS` list applies; an empty list means nobody) can make, see or revoke keys, and only as an administrator or owner of the organization. The server checks it on every call, and the button in the Templates gallery ("API keys for other systems") shows only for them. A person who was already signed in when this was deployed signs in once more to see it. They make a key: a name, which templates it may read (the built-in ones, the organization's own, or both) and when it expires. The key (`cb_` and 43 characters) is shown once; only its SHA-256 hash is stored in the `apiKey` table (migration `add_api_keys`). Revoking it stops it at once.
Another system reads with `Authorization: Bearer cb_…` (or `X-API-Key`):
```
GET /api/public/templates                      the list (descriptive fields)
GET /api/public/templates?graphs=1             a full export, with every template's resources and connections
GET /api/public/templates?provider=aws&category=Custom
GET /api/public/templates/<id>                 one template with its graph
```
A key reads nothing else, and every bad key (none, malformed, unknown, revoked, expired) gets the same 401. Failed attempts are limited to 30 a minute per address, and a working key to 120 a minute. After a deploy that includes this, run `npm run db:migrate` on the server.

## Neozaar marketplace export
`GET /api/public/templates?format=neozaar` (with an API key, see above) gives every template as the body of Neozaar's Create Service request (`POST /catalog/product`, multipart): `catalog.fields` are the text fields, with the list fields (`target_audience`, `industry`, `target_segments`, `cta_model`, `category`, `category_subcategory`, `cloud_provider_support`, `regions_supported`, `tags`) as JSON strings, and `catalog.service_solution_details` is the JSON for that field (overview, approach, scope, outcome, challenges, coverage). Each template also has `ready`, `missing` (required fields with no value) and `review` (fields filled from a default or an estimate, to read before publishing). `?ready=1` keeps only the ready ones; `/api/public/templates/<id>?format=neozaar` gives one. Neozaar saves everything created this way as an unpublished draft.
- Fixed values: type `product`, `action_type` service, `brand_name` Neozaar, `action_for` both, regions Global, pricing model Monthly Subscription.
- Price: the template's estimated monthly cloud running cost in rupees (rate `CLOUDBUILDER_NEOZAAR_USD_INR`, default 85). It is an indication, not a sale price; the export lists it for review.
- Everything else Neozaar-specific is in `lib/marketplace/neozaarConfig.ts`: the values the form offers, how CloudBuilder's categories map to Neozaar categories and sub-categories (SaaS and E-Commerce are proposals to confirm), the defaults for audience, segment, industry and CTA, a first-draft business problem per category, and the key names inside `service_solution_details` (to confirm against Neozaar's `productOtherDetails` model).
- Only the same people (`CLOUDBUILDER_API_KEY_MANAGERS`, above) can use the listing routes, and writing also needs an administrator or owner. They can write a template's own details with `PUT /api/architecture-templates/<id>/listing` (challenges, outcomes, pricing model, starting price in rupees, audience, segments, industries, CTA, regions, category, sub-category, differentiator, terms URL). `GET` shows it with the request it produces, `DELETE` puts the defaults back. They are stored in `templateListing` (migration `add_template_listing`), apart from the template, so the sync never overwrites them. After a deploy: `npm run db:migrate`.


## Settings for the in-app release

- `CLOUDBUILDER_GIT_ALLOWED_HOSTS`: the Git hosts the in-app release may take code from (comma separated, https only). Default `github.com,gitlab.com,bitbucket.org,dev.azure.com`.
  Add your own host (for example `git.example.com`) to use a self-hosted Git server. The server needs `git` installed.

## Security of the server

Run `ssh root@SERVER 'bash -s -- check' < scripts/server-security.sh` after a deploy and after any change to the server. See `docs/SERVER_SECURITY.md` for what it checks, how to turn SSH passwords off safely, and the firewall commands.
`CLOUDBUILDER_ALLOWED_ORIGINS` (comma separated) lists other websites whose pages may make changes in the app; leave it empty unless you have a sibling subdomain that needs it.
