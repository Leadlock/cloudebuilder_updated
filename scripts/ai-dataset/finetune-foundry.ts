/**
 * Fine-tunes the CloudBuilder architect on Azure AI Foundry (Azure OpenAI v1 API).
 *
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/ai-dataset/finetune-foundry.ts start [--base gpt-4o-mini-2024-07-18] [--type GlobalStandard] [--epochs 3] [--suffix cloudcraft-architect]
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/ai-dataset/finetune-foundry.ts status <jobId>
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/ai-dataset/finetune-foundry.ts events <jobId>
 *
 * Uses AZURE_AI_FOUNDRY_ENDPOINT + AZURE_AI_FOUNDRY_API_KEY (the key is never printed).
 * Deploying the finished model is NOT done here: Azure requires the ARM control plane (Entra token) for that —
 * deploy it from the Foundry portal, then set AZURE_AI_FOUNDRY_DEPLOYMENT to the deployment name.
 */
import { readFileSync } from 'node:fs';

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const base = (process.env.AZURE_AI_FOUNDRY_ENDPOINT ?? '').replace(/\/responses\/?$/, '');
const key = process.env.AZURE_AI_FOUNDRY_API_KEY;
if (!base || !key) { console.error('AZURE_AI_FOUNDRY_ENDPOINT / AZURE_AI_FOUNDRY_API_KEY are not set (run with --env-file=.env)'); process.exit(2); }

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'api-key': key!, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function upload(file: string): Promise<string> {
  const form = new FormData();
  form.append('purpose', 'fine-tune');
  form.append('file', new Blob([readFileSync(file)]), file.split('/').pop()!);
  const out = await call('/files', { method: 'POST', body: form });
  console.log(`uploaded ${file} -> ${out.id} (${out.bytes} bytes, status ${out.status})`);
  return out.id;
}

async function waitProcessed(id: string) {
  for (let i = 0; i < 60; i++) {
    const f = await call(`/files/${id}`);
    if (f.status === 'processed') return;
    if (f.status === 'error') throw new Error(`file ${id} failed processing: ${JSON.stringify(f.status_details ?? f)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`file ${id} still not processed after 5 minutes`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'status' || cmd === 'events') {
    const id = process.argv[3];
    if (!id) throw new Error('job id required');
    if (cmd === 'status') {
      const j = await call(`/fine_tuning/jobs/${id}`);
      console.log(JSON.stringify({ id: j.id, status: j.status, model: j.model, fine_tuned_model: j.fine_tuned_model, trained_tokens: j.trained_tokens, error: j.error, result_files: j.result_files }, null, 2));
    } else {
      const e = await call(`/fine_tuning/jobs/${id}/events?limit=30`);
      for (const ev of [...e.data].reverse()) console.log(`${new Date(ev.created_at * 1000).toISOString()} ${ev.level} ${ev.message}`);
    }
    return;
  }
  if (cmd !== 'start') { console.error('usage: start | status <jobId> | events <jobId>'); process.exit(2); }

  const train = await upload('datasets/ai-architect/train.jsonl');
  const validation = await upload('datasets/ai-architect/validation.jsonl');
  await Promise.all([waitProcessed(train), waitProcessed(validation)]);

  const job = await call('/fine_tuning/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      training_file: train, validation_file: validation,
      model: arg('--base') ?? 'gpt-4o-mini-2024-07-18',
      suffix: arg('--suffix') ?? 'cloudcraft-architect',
      seed: 20260929,
      hyperparameters: { n_epochs: Number(arg('--epochs') ?? 3) },
      trainingType: arg('--type') ?? 'GlobalStandard',
    }),
  });
  console.log(JSON.stringify({ jobId: job.id, status: job.status, model: job.model, trainingFile: train, validationFile: validation }, null, 2));
  console.log(`\nCheck progress:  npx tsx --env-file=.env --tsconfig tsconfig.json scripts/ai-dataset/finetune-foundry.ts status ${job.id}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
