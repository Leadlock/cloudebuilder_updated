# Readiness reports (SOC 2 Type 1, AWS and Azure Well-Architected)

CloudBuilder > **Readiness Reports**. For each project it shows where every control stands, what supports it, and what to do next, and produces:

| Framework | Controls | Output |
| --- | --- | --- |
| SOC 2 Type 1 readiness | 38 criteria, 63 controls (Security always; Availability and Confidentiality selectable) | Word document (.docx), editable |
| AWS Well-Architected | 56 questions in six pillars | PDF |
| Azure Well-Architected | 59 recommendations in five pillars | PDF |

**These are readiness reports.** They are not an audit, a certification or a SOC 2 report, and never say so. Only a CPA firm issues a SOC 2 report; the Word document is built for that firm (and the company) to start from: scope, draft system description, draft management assertion, control matrix, evidence index, findings with management's response, limitations, and a "ready for the CPA firm?" checklist. A test (`__tests__/reportClaims.test.ts`) fails the build if report text claims a result is certified, attested or "SOC 2 compliant".

## How a control is scored

0 Missing · 1 Informal · 2 Implemented · 3 Operating · 4 Audit-ready, with a confidence (High/Medium/Low).

- The score comes from **checks** (on the design, from the cloud account, from CloudBuilder's own records) and **evidence**, never from a tick box.
- An owner's answer alone is worth at most 1. A failing check keeps a control at 2 or below.
- Evidence counts as current when dated within 365 days of the report date and not expired.
- 4 needs a live check or system evidence **and** a review by someone other than the control's owner.
- "Not assessed" (nobody answered) is not "Not applicable" (which needs a written reason). Any not-assessed control keeps the report at *Incomplete*.

## What is stored

Per project: control answers (owner, status, note, reviewer), findings (owner, target date, status, management's response, re-test), sign-offs (preparer, then a different reviewer, then management), issued report versions, SOC 2 scope with reasons for exclusions, and the **evidence vault**: files (up to 5 MB, documents and data only), links (https) and written notes, each with the date produced, system or manual origin, optional expiry and the controls it supports. Files are encrypted at rest (AES-256-GCM, bound to the project and item) with a SHA-256 on record; removing evidence keeps the record, marked removed, and deletes the file. Any change to a control, finding, evidence or scope clears the sign-offs.

## API (all under `/api/projects/{id}/readiness/{soc2|aws-waf|azure-waf}`)

`GET` view · `PUT controls/{controlId}` · `PUT findings/{controlId}` · `GET|POST evidence`, `GET|PUT|DELETE evidence/{id}` · `POST signoff` · `PUT scope` (SOC 2, owner/admin) · `GET report?format=` draft, `POST report` issues the next version. Every call checks the caller belongs to the project's organization.

## Toward a real SOC 2 report

CloudBuilder cannot issue a SOC 2 report: only a licensed CPA firm can, after its own examination. What it does is make that engagement shorter.

- **Evidence over time (Type 2 preparation).** Every night at 03:30 UTC the worker (`cloudcraft-discovery`, which already owns the job queue) takes a dated snapshot of every control for each project that uses the reports, and one is taken whenever you issue a version or press "Take a snapshot now". Appendix G of the SOC 2 report shows what the snapshots say for the last year: how many, any gap longer than 7 days, and which controls operated (score 3 or more, no failing check) in every one. It is preparation, not a Type 2 result.
- **Auditor package.** One zip: the report (Word and PDF for SOC 2), `controls.csv`, `findings.csv`, every evidence file, `evidence-index.csv` (each file's fingerprint re-checked when the package is built, with MISMATCH or FILE MISSING flagged), `signoffs.csv`, `snapshots.csv`, and `manifest.json` with the SHA-256 of every file.
- **Read-only auditor access.** An owner or admin makes a link for a named auditor, 1 to 90 days, at most ten active per framework. The link is `/auditor#<token>`: the token sits after the `#`, so it is never sent in a URL, never written to an access log and never passed on in a Referer header; the page sends it as a header. Only its SHA-256 is stored, and the link is shown once. It reaches only that framework's report, controls, findings and the evidence linked to it, and the package. It has no write routes. Every refusal (missing, malformed, unknown, expired, revoked) returns the same 401. Revoke it at any time.

API additions: `GET|POST .../snapshots`, `GET .../package`, `GET|POST .../auditor-access`, `DELETE .../auditor-access/{id}`; for the auditor: `GET /api/auditor/view`, `GET /api/auditor/evidence/{id}`, `GET /api/auditor/package` with `Authorization: Bearer ca_...`. Tables: `readinessSnapshot`, `readinessAuditorAccess` (migration `add_readiness_snapshots_and_auditor_access`).

## Developing

`lib/compliance/`: `scoring.ts`, `model.ts` (pure), `soc2/` (criteria and control catalog), `frameworks.ts`, `report.ts` (report as data), `renderSoc2Docx.ts`, `renderControlPdf.ts`, `service.ts` (assembles a project's input), `rules.ts` (independence and validation rules), `facts.ts` (platform facts). Tables are `readiness*` (migration `add_readiness_records`). `npx tsc` needs `NODE_OPTIONS=--max-old-space-size=8192` now that the contract is larger.
