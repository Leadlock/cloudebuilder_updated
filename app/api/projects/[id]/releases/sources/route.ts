/**
 * POST /api/projects/[id]/releases/sources — upload the zip of a service's own code, to be built instead of the generated sample.
 * Body: multipart form with `layer` (frontend, backend or api) and `file` (a .zip, up to 5 MB).
 *
 * The zip is read here with strict checks (no links, no paths outside the folder, no bombs; see lib/deploy/project/zip.ts) and kept for a few days.
 * The release is planned with the id this returns; its approval then covers the SHA-256 of exactly this file. The generated Dockerfile (and .dockerignore
 * and nginx.conf) is used, not one from the zip.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { created, internalError, badRequest, tooManyRequests, apiError } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { PgSourceStore, SOURCE_TTL_MS } from '@/lib/deploy/project/sourceStore';
import { DEFAULT_ZIP_LIMITS, readZip, ZipError } from '@/lib/deploy/project/zip';
import { KEPT_FROM_GENERATED } from '@/lib/deploy/project/bundle';
import { releaseGate } from '@/lib/deploy/project/routeGate';

export const dynamic = 'force-dynamic';

const LAYERS = new Set(['frontend', 'backend', 'api']);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const { identity, orgId } = gate;

    // Before reading anything: the size the client says, then the size it really is.
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > DEFAULT_ZIP_LIMITS.maxZipBytes + 64 * 1024) return apiError('PAYLOAD_TOO_LARGE', `The zip may be at most ${DEFAULT_ZIP_LIMITS.maxZipBytes / 1024 / 1024} MB.`, 413);

    const rl = await checkRateLimit(`${identity.userId}:release-source`, 20, 10 * 60_000);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    let form: FormData;
    try { form = await req.formData(); } catch { return badRequest('Send the zip as a form with a "layer" and a "file".'); }
    const layer = String(form.get('layer') ?? '');
    const file = form.get('file');
    if (!LAYERS.has(layer)) return badRequest('The layer must be frontend, backend or api.');
    if (!(file instanceof File)) return badRequest('Send the zip as the "file" of the form.');
    if (file.size > DEFAULT_ZIP_LIMITS.maxZipBytes) return apiError('PAYLOAD_TOO_LARGE', `The zip may be at most ${DEFAULT_ZIP_LIMITS.maxZipBytes / 1024 / 1024} MB.`, 413);

    const zip = Buffer.from(await file.arrayBuffer());
    let contents;
    try { contents = readZip(zip); } catch (err) {
      await recordTerraformAudit({ action: 'release', outcome: 'blocked', orgId, projectId, userId: identity.userId, detail: `uploaded code for ${layer} refused: ${err instanceof ZipError ? err.message : 'unreadable'}` });
      return badRequest(err instanceof ZipError ? err.message : 'The zip could not be read.');
    }

    const store = new PgSourceStore();
    await store.prune().catch(() => undefined);
    const stored = await store.put({ id: randomUUID(), orgId, projectId, layer, zip, expiresAtMs: Date.now() + SOURCE_TTL_MS });
    await recordTerraformAudit({ action: 'release', outcome: 'allowed', orgId, projectId, userId: identity.userId, detail: `uploaded code for ${layer}: ${contents.files.length} files, ${stored.sizeBytes} bytes, sha256 ${stored.sha256.slice(0, 12)}` });
    return created({
      sourceId: stored.id, layer, files: contents.files.length, bytes: stored.sizeBytes, sha256: stored.sha256, skipped: contents.skipped.length,
      replaced: contents.files.map((f) => f.path).filter((p) => KEPT_FROM_GENERATED.has(p)),
      expiresAt: new Date(stored.expiresAtMs).toISOString(),
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/releases/sources]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
