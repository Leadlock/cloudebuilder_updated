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

## Developing

`lib/compliance/`: `scoring.ts`, `model.ts` (pure), `soc2/` (criteria and control catalog), `frameworks.ts`, `report.ts` (report as data), `renderSoc2Docx.ts`, `renderControlPdf.ts`, `service.ts` (assembles a project's input), `rules.ts` (independence and validation rules), `facts.ts` (platform facts). Tables are `readiness*` (migration `add_readiness_records`). `npx tsc` needs `NODE_OPTIONS=--max-old-space-size=8192` now that the contract is larger.
