/**
 * Fails when a production dependency has a high or critical advisory that security/audit-policy.json does not accept (see lib/scan/audit.ts).
 *   npx tsx --tsconfig tsconfig.json scripts/audit-gate.ts        needs the network (the npm registry's advisory service)
 * Exit 0 passes, 1 fails, 2 when the audit itself could not run: an audit that cannot run is never a pass.
 */
import { appendFileSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { auditReport, evaluateAudit, validateAuditPolicy, type AuditJson, type AuditPolicy } from '../lib/scan/audit';

const policy = JSON.parse(readFileSync('security/audit-policy.json', 'utf8')) as AuditPolicy;
const problems = validateAuditPolicy(policy);
if (problems.length) { console.error(`security/audit-policy.json is not valid:\n- ${problems.join('\n- ')}`); process.exit(2); }

const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let audit: AuditJson;
try { audit = JSON.parse(r.stdout) as AuditJson & { error?: unknown }; if ((audit as { error?: unknown }).error) throw new Error(JSON.stringify((audit as { error: unknown }).error).slice(0, 200)); }
catch (e) { console.error(`npm audit did not give a usable answer (${(e as Error).message}). ${(r.stderr || '').slice(0, 300)}`); process.exit(2); }

const verdict = evaluateAudit(audit, policy);
const report = auditReport(verdict);
console.log(report);
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], report);
process.exit(verdict.ok ? 0 : 1);
