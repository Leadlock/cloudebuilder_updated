/**
 * Scans the files CloudBuilder generates with Trivy (misconfigurations in Terraform, Dockerfiles and Kubernetes manifests) and applies security/scan-policy.json.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/scan-generated.ts [dir]        dir (default: a temporary folder) keeps the generated cases and the reports
 *
 * Trivy is the pinned version in security/trivy.json, run in Docker by its digest, or the `trivy` on the PATH / TRIVY_BIN when that is the same version.
 * It uses the checks that ship inside that version (--skip-check-update), so the same files always give the same findings.
 * Exits 1 when the scan fails (see lib/scan/trivy.ts). Writes scan-report.md and scan-findings.json in the folder, and adds the report to the GitHub job summary.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { scanCases } from './scan/cases';
import { evaluate, parseTrivy, report, validatePolicy, type Policy } from '../lib/scan/trivy';

const root = resolve(process.argv[2] ?? join(tmpdir(), 'cloudbuilder-scan'));
const pin = JSON.parse(readFileSync('security/trivy.json', 'utf8')) as { version: string; image: string };
const policy = JSON.parse(readFileSync('security/scan-policy.json', 'utf8')) as Policy;

const problems = validatePolicy(policy);
if (problems.length > 0) { console.error(`security/scan-policy.json is not valid:\n- ${problems.join('\n- ')}`); process.exit(2); }

const cases = scanCases();
const casesDir = join(root, 'cases');
rmSync(root, { recursive: true, force: true });
for (const c of cases) for (const f of c.files) { const p = join(casesDir, c.name, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
console.log(`Generated ${cases.length} cases (${cases.reduce((n, c) => n + c.files.length, 0)} files) in ${casesDir}`);

const args = ['config', '--skip-check-update', '--format', 'json', '--quiet'];
const bin = process.env['TRIVY_BIN'];
const run = bin
  ? spawnSync(bin, [...args, '--output', join(root, 'trivy.json'), casesDir], { encoding: 'utf8' })
  : spawnSync('docker', ['run', '--rm', '-v', `${casesDir}:/scan:ro`, '-v', `${root}:/out`, pin.image, ...args, '--output', '/out/trivy.json', '/scan'], { encoding: 'utf8' });
if (run.status !== 0) { console.error(`Trivy failed (exit ${run.status}):\n${(run.stderr || run.stdout).slice(-1500)}`); process.exit(2); }

const findings = parseTrivy(JSON.parse(readFileSync(join(root, 'trivy.json'), 'utf8')));
const result = evaluate(findings, policy);
const md = report(result, { cases: cases.length, trivy: pin.version, failOn: policy.failOn });
writeFileSync(join(root, 'scan-report.md'), md + '\n');
writeFileSync(join(root, 'scan-findings.json'), JSON.stringify(findings, null, 1));
console.log(md);
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], md + '\n');
process.exit(result.passed ? 0 : 1);
