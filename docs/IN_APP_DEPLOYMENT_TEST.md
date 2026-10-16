# Trying "Deploy from CloudCraft" on a real Azure subscription

This is the checklist for the first real run. Everything below the cloud (the state machine, the routes, the zip reader, the panel) is tested with fakes;
**the Azure REST calls and the generated Terraform and start-up scripts have never run against Azure.** Expect to find something. Use a throw-away subscription.

## 0. What you need
- An Azure subscription you may spend a few dollars in, with a **service principal** connected in CloudCraft (Cloud Accounts) that has **Owner**, or **Contributor +
  User Access Administrator**, on it. Terraform creates role assignments (AcrPull, Key Vault Secrets Officer/User), so Contributor alone is refused. The principal also
  stores secrets in the Key Vault it creates: that works through the Key Vault Secrets Officer role Terraform gives it (it can take a minute to apply; CloudCraft retries for 5 minutes).
- A **storage account and container** for Terraform's state (the Deploy tab's "create backend" button makes one). The deployment uses its own state file in it.
- You are on the restricted-features list and an owner/admin; Terraform access is approved for your organization (same as the Deploy tab).

## 1. Switch it on (on the machine that runs CloudCraft)
1. Put `CLOUDCRAFT_PROJECT_RELEASES=1` in `.env` and restart the web server **and** the worker (`npm run worker:terraform-apply`, or `pm2 restart cloudcraft-web cloudcraft-tf-apply --update-env`).
2. The database must have the two new tables: `npm run db:migrate` (or `prisma db migrate`). Migrations: `add_project_releases`, `add_project_sources`.
3. Behind nginx: `client_max_body_size 6m;` so a zip of up to 5 MB can be uploaded.

## 2. Make the project
Container Templates, then Stack: tick **Backend** and **API** (add Frontend and Database on a second run). Choose **Azure VM** under "Deploy to". For the first run leave the
sample apps (tick "Include a sample app" on each part) so there is something to build; the "Deploy from CloudCraft" box appears under the settings.

## 3. Run it
1. Pick the Azure account; check the state storage (prefilled from the Deploy tab); **Plan the deployment**. You should see "N to create, 0 to change, 0 to destroy" and a cost.
2. Enter your password (and authenticator code if asked) and **Confirm and deploy**.
3. Watch the steps. The first ones take the longest (Terraform about 5 to 10 minutes). When it says it waits for secrets, enter them (the database password is yours to choose: letters, digits and `. _ ~ -`) and press the button.
4. When it succeeds it shows the address. Open it.

## 4. What to check, and what to send me if it fails
| Step | If it fails, send | Likely cause |
|---|---|---|
| Plan | the message in red | state storage name, permissions, a Terraform error |
| infrastructure | the release's last log lines | role assignment missing (AuthorizationFailed), quota or SKU not available in the region |
| secrets | the message | the role has not applied yet (wait and press Continue); the principal lacks Key Vault Secrets Officer |
| build | the message (it includes the end of the build log) | a Dockerfile problem; the registry task not allowed in the subscription |
| publish / start | the message | the VM agent is not ready yet (wait, Retry) |
| verify | the message | the address is closed to your network (the range in "who can connect"), or the services are still starting |

Server side, the worker log (`pm2 logs cloudcraft-tf-apply`) has one line per step (`[project-release …]`) and the audit trail records every request (`action: release`).

## 5. Then try
- **A second release** (change the image tag): it should plan with no changes to the VM, build, publish and restart without replacing the VM; database data (if ticked) survives.
- **Put an earlier release back** ("Earlier releases that worked").
- **Your own code**: upload a zip for one service; the generated Dockerfile builds it.
- **A failing release**: use a tag that does not build; the previous release should keep answering.
- **Remove everything**: preview, type the project name, confirm. Check in the portal that `rg-<project>` is gone and the page says "destroyed".

## 6. Cost and cleanup
About $60 to $90 a month while it runs (VM, disk, IP, registry). Always finish with **Remove everything** (or `az group delete -n rg-<project>`); a key vault that was deleted by hand stays soft-deleted for 7 days, and the next deployment of the same project recovers it.
