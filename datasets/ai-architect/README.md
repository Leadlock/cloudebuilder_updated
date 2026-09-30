# CloudCraft architect — fine-tuning dataset & knowledge base

Data for fine-tuning `gpt-4o-mini` to turn a plain-English requirement into a complete AWS, Azure or
multi-cloud architecture that CloudCraft can lay out, assess and export to Terraform without edits.

| File | Purpose |
|---|---|
| `train.jsonl`, `validation.jsonl` | OpenAI chat fine-tuning files (system / user / assistant). |
| `eval-prompts.jsonl` | 40 held-out prompts (never in train/validation) for scoring a tuned model. |
| `manifest.json` | Counts by provider / pattern / scale / region, token estimate, generation stats. |
| `rejected.json` | Candidates dropped by the gates during generation (empty = none). |
| `knowledge-base/` | Markdown + `knowledge-base.jsonl` chunks for file search / RAG (see below). |

## What is in the dataset

706 examples (see `manifest.json` for exact numbers): 530 design examples across 10 patterns — AWS three-tier (EC2 Auto Scaling),
ECS Fargate, EKS, serverless; Azure three-tier (VMSS), App Service, Functions, AKS; AWS-primary/Azure-DR and
active-active multi-cloud — varied over region, scale, database, cache, CDN, queue (AWS) and regulated workloads.
The remaining 176 are **repair examples**: a design broken in one realistic way (missing WAF, public database,
overlapping CIDR, reversed connection, …), the *real* validator output for it, and the corrected design.

The assistant answer is a compact `ArchitectureSpec` JSON (resources with `id/type/label/parent/config`, and
`connections`). It contains **no coordinates**: `lib/ai/architectureSpec.ts` compiles it into the canvas graph and
`autoLayoutArchitecture` positions it. That is deliberate — a language model cannot be trusted to emit a
non-overlapping layout, but it can reliably choose resources, nesting and connections.

## Why you can trust the examples

Nothing is hand-written prose. Every design is produced by code (`scripts/ai-dataset/*Patterns.ts`), then must pass
**all** of these gates before it is written (`checkDeployReadiness`):

1. Assessment (Security + Well-Architected rules): no FAIL/WARNING at MEDIUM or above, no INSUFFICIENT_DATA.
2. Hardening: no remaining LOW findings that have a verified safe auto-fix.
3. Architecture validator, and canonical validation.
4. Connectivity: every resource connected; nothing split off; valid direction.
5. Layout: compiled layout has no overlaps and correct nesting.
6. Network addressing: valid CIDRs, subnets inside the VPC/VNet range, no overlaps.
7. Terraform renders for every resource.

`npm test` re-checks a sample of the committed files; `npm run ai:dataset` re-verifies every one when regenerating
(all 706 assistant designs were verified with zero failures at the time of writing).

## Limits you should know about

- **Passing the gates is not the same as a successful `terraform apply`.** The gates prove internal consistency,
  security posture and that Terraform *renders*. Nothing was applied to a real account.
- **Placeholders.** Account-specific values are written as `REPLACE-WITH-YOUR-*` (ACM certificate ARN, container
  image). They are surfaced by `collectDeploymentInputs()`. A design that needs them is *not* deployable until supplied — by design, we don't invent ARNs.
- **Prompts are templated** (4 phrasing styles over structured requirements). The model will follow those shapes best;
  free-form or unusual requests will generalise less well. Add real user prompts (with an engine-verified design) to improve this.
- **Designs within a pattern are structurally similar.** That is what makes the output consistent, but the model
  learns 10 patterns plus their variations, not arbitrary topologies. Requests outside them (e.g. API Gateway, Kinesis,
  Service Bus — not in the resource catalog) will not be served; `design-guidelines.md` tells the model not to invent types.
- Azure relational databases are modelled as **Azure SQL** only; the Azure "queue" option doesn't exist.
- Rule references (FSBP, MCSB, Well-Architected URLs) inherit the verification status documented in
  `docs/security-assessment/AUDIT.md`; some remain "reference verification required".
- Nothing here is a compliance certification.

## Fine-tuning steps (OpenAI)

Confirm your account can fine-tune `gpt-4o-mini` and check current pricing first.

1. Upload files (Platform → Fine-tuning → Create, or the API):
   ```bash
   curl https://api.openai.com/v1/files -H "Authorization: Bearer $OPENAI_API_KEY" -F purpose=fine-tune -F file=@datasets/ai-architect/train.jsonl
   curl https://api.openai.com/v1/files -H "Authorization: Bearer $OPENAI_API_KEY" -F purpose=fine-tune -F file=@datasets/ai-architect/validation.jsonl
   ```
2. Create the job with base model `gpt-4o-mini-2024-07-18`, the training file, the validation file, and a suffix such as
   `cloudcraft-architect`. Start with **3 epochs** and the default batch size / learning-rate multiplier; watch validation
   loss and stop early if it rises. Training size is roughly 1.3M tokens per epoch (estimate at 4 chars/token; the manifest has the number).
3. Score the result on prompts it never saw:
   ```bash
   OPENAI_API_KEY=… npm run ai:evaluate -- --model ft:gpt-4o-mini-2024-07-18:<org>::<id>
   ```
   It reports first-try pass rate, pass rate with the repair loop, and failures grouped by gate. Aim to improve on the
   **untuned** `gpt-4o-mini` baseline (run the same command with `--model gpt-4o-mini`) rather than trust an absolute number.
4. In production always run the guardrail — never ship raw model output:
   ```ts
   import { generateWithRepair } from '@/lib/ai/architectRepair';
   const out = await generateWithRepair((messages) => callFineTunedModel(messages), userPrompt, 3);
   if (out.ok) { /* out.graph is the canvas graph; out.deploymentInputs lists values the user must supply */ }
   ```
   The repair prompt has exactly the format used by the repair examples, so the model has seen it in training.
   Use the same system prompt (`ARCHITECT_SYSTEM_PROMPT`) at inference as in training.

## Adding the knowledge base

`knowledge-base/` is generated from the code that enforces the rules, so it can't drift:
`resource-catalog.md` (every type, its parent rules, valid settings and options), `connection-rules.md`
(connections used by verified designs with inferred protocol/port), `assessment-rules.md` (115 rules, severity,
recommendation), `architecture-patterns.md` (verified sample designs) and `design-guidelines.md`.

- **OpenAI file search / Assistants / custom GPT:** upload the `.md` files (or `knowledge-base.jsonl`, one chunk per
  line with `id`, `title`, `text`, `metadata`) to a vector store and attach it.
- **Your own RAG:** embed each JSONL `text` and filter on `metadata.kind` (`resource`, `connections`, `rule`, `pattern`, `guideline`).
- Fine-tuning teaches format and habits; retrieval supplies facts that change (settings, rules). Use both.

## Regenerating

```bash
npm run ai:dataset          # train/validation/eval/manifest/rejected (deterministic, seed in build-dataset.ts)
npm run ai:knowledge-base   # knowledge-base/
```
Re-run both after changing the resource catalog, rules or blueprints. Blueprints that stop passing are reported in `rejected.json` and never written.
To add a pattern: write a blueprint in `scripts/ai-dataset/`, register it in `build-dataset.ts` and `build-knowledge-base.ts`, and add it to `__tests__/aiArchitectDataset.test.ts`.
