/**
 * POST /api/projects/[id]/releases/sources/git — take a service's code from a Git repository, to be built instead of the generated sample.
 * Body (JSON): `layer` (frontend, backend or api), `url` (https address), optional `ref` (branch, tag or commit; default the repository's own default),
 * optional `subdir` (a folder of the repository) and optional `token` (an access token, for a private repository; used for this request only).
 *
 * The repository is fetched safely (lib/deploy/project/gitSource.ts), made into a zip, read again with the same strict checks as an upload, and kept for
 * a few days. It returns the same `sourceId` and `sha256` an upload does, plus the commit that was taken: the release is planned with that id and its
 * approval covers exactly that content. The token is never stored, logged or returned.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { created, internalError, badRequest, tooManyRequests, parseBody } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { PgSourceStore, SOURCE_TTL_MS } from '@/lib/deploy/project/sourceStore';
import { readZip, ZipError } from '@/lib/deploy/project/zip';
import { KEPT_FROM_GENERATED } from '@/lib/deploy/project/bundle';
import { releaseGate } from '@/lib/deploy/project/routeGate';
import { fetchGitSource, GitSourceError, gitPolicyFromEnv } from '@/lib/deploy/project/gitSource';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Schema = z.object({
  layer: z.enum(['frontend', 'backend', 'api']),
  url: z.string().min(1).max(500),
  ref: z.string().max(200).optional(),
  subdir: z.string().max(200).optional(),
  token: z.string().max(512).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const { identity, orgId } = gate;

    const rl = await checkRateLimit(`${identity.userId}:release-source-git`, 10, 10 * 60_000);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const parsed = await parseBody(req, Schema);
    if (!parsed.ok) return parsed.response;
    const { layer, url, ref, subdir, token } = parsed.data;

    let fetched;
    try {
      fetched = await fetchGitSource({ url, ref, subdir, token }, gitPolicyFromEnv());
    } catch (err) {
      const message = err instanceof GitSourceError ? err.message : 'The code could not be fetched.';
      // The address and the reason, never the token.
      await recordTerraformAudit({ action: 'release', outcome: 'blocked', orgId, projectId, userId: identity.userId, detail: `code from git for ${layer} refused (${url.slice(0, 120)}): ${message.slice(0, 160)}` });
      return badRequest(message);
    }

    let contents;
    try { contents = readZip(fetched.zip); } catch (err) { return badRequest(err instanceof ZipError ? err.message : 'The code could not be read.'); }

    const store = new PgSourceStore();
    await store.prune().catch(() => undefined);
    const stored = await store.put({ id: randomUUID(), orgId, projectId, layer, zip: fetched.zip, expiresAtMs: Date.now() + SOURCE_TTL_MS });
    await recordTerraformAudit({
      action: 'release', outcome: 'allowed', orgId, projectId, userId: identity.userId,
      detail: `code from git for ${layer}: ${fetched.host}/${fetched.repo}@${fetched.commit.slice(0, 12)}${fetched.subdir ? ` (${fetched.subdir})` : ''}, ${contents.files.length} files, ${stored.sizeBytes} bytes, sha256 ${stored.sha256.slice(0, 12)}${token ? ', with a token' : ''}`,
    });
    return created({
      sourceId: stored.id, layer, files: contents.files.length, bytes: stored.sizeBytes, sha256: stored.sha256, skipped: contents.skipped.length,
      replaced: contents.files.map((f) => f.path).filter((p) => KEPT_FROM_GENERATED.has(p)),
      expiresAt: new Date(stored.expiresAtMs).toISOString(),
      git: { host: fetched.host, repo: fetched.repo, ref: fetched.ref, commit: fetched.commit, subdir: fetched.subdir },
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/releases/sources/git]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
