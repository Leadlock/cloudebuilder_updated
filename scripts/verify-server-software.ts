/**
 * Runs the first-boot script CloudCraft generates for "Install on the server" inside real operating-system containers (Amazon Linux 2023, Ubuntu,
 * Debian), one software item at a time, then runs that item's own check command. Catches wrong package names before a person finds out on a server.
 * Needs Docker and internet. Not part of `npm test`. Run: npx tsx --tsconfig tsconfig.json scripts/verify-server-software.ts [item ...]
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { SOFTWARE, softwareScript, type PackageFamily } from '../lib/engines/servers/software';

const dir = join(process.env['RUNNER_TEMP'] ?? '/tmp', 'verify-server-software');
const targets: { image: string; family: PackageFamily; user: string }[] = [
  { image: 'amazonlinux:2023', family: 'dnf', user: 'ec2-user' },
  { image: 'ubuntu:22.04', family: 'apt', user: 'ubuntu' },
  { image: 'debian:12', family: 'apt', user: 'admin' },
];
const only = process.argv.slice(2);
const items = SOFTWARE.filter((s) => only.length === 0 || only.includes(s.id));

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let failed = 0;
for (const t of targets) {
  for (const item of items) {
    const file = join(dir, `${t.image.replace(/[^a-z0-9]/g, '_')}-${item.id}.sh`);
    writeFileSync(file, softwareScript([item], { family: t.family, loginUser: t.user, pageText: 'Hello from CloudCraft' }));
    const verify = item.verify[t.family];
    const r = spawnSync('docker', ['run', '--rm', '-v', `${file}:/setup.sh:ro`, t.image, 'bash', '-c', `bash /setup.sh && ${verify}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) console.log(`ok    ${t.image}  ${item.id}`);
    else { failed++; console.log(`FAIL  ${t.image}  ${item.id}\n${`${r.stdout}\n${r.stderr}`.split('\n').slice(-25).join('\n')}`); }
  }
}
console.log(failed === 0 ? 'All software installs verified.' : `${failed} install(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
