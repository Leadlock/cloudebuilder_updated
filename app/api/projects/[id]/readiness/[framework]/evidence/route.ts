/**
 * /api/projects/[id]/readiness/[framework]/evidence
 *
 * GET  — the project's evidence (every framework shares one vault), without the files.
 * POST — add evidence: a file (multipart/form-data, up to 5 MB, documents and data only), a link, or a written note. Each item carries the date it was
 *        produced, whether it came from a system or was collected by hand, and the controls it supports. Files are stored encrypted with a SHA-256 on record.
 */
import { NextRequest } from 'next/server';
import type { z } from 'zod';
import { ok, created, badRequest, internalError, parseBody, containsNulCharacter } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { EvidenceMetaSchema, checkControlKeys, present } from '@/lib/compliance/evidenceInput';
import { EVIDENCE_EXTENSIONS, fileExtension, MAX_EVIDENCE_BYTES, safeFileName, sha256Of } from '@/lib/compliance/rules';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const today = () => new Date().toISOString().slice(0, 10);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params);
    if ('response' in caller) return caller.response;
    return ok({ evidence: (await readinessRepository.evidence(caller.projectId)).map(present) });
  } catch (err) {
    console.error('[GET readiness evidence]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { limitKey: 'readiness-evidence' });
    if ('response' in caller) return caller.response;

    let meta: z.infer<typeof EvidenceMetaSchema>;
    let file: { bytes: Buffer; name: string } | undefined;
    if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > MAX_EVIDENCE_BYTES + 64 * 1024) return badRequest(`A file can be at most ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB.`);
      const form = await req.formData();
      const f = form.get('file');
      if (!(f instanceof File)) return badRequest('Attach a file in the "file" field.');
      if (f.size > MAX_EVIDENCE_BYTES) return badRequest(`A file can be at most ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB.`);
      const name = safeFileName(f.name);
      if (!EVIDENCE_EXTENSIONS.has(fileExtension(name))) return badRequest(`Files of type ".${fileExtension(name)}" are not accepted. Accepted: ${[...EVIDENCE_EXTENSIONS].join(', ')}.`);
      const raw = Object.fromEntries([...form.entries()].filter(([k]) => k !== 'file'));
      if (containsNulCharacter(raw)) return badRequest('The request contains an invalid character.');
      const parsed = EvidenceMetaSchema.safeParse({ ...raw, kind: 'file', controls: typeof raw['controls'] === 'string' ? JSON.parse(raw['controls'] as string) : [] });
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid evidence details');
      meta = parsed.data;
      file = { bytes: Buffer.from(await f.arrayBuffer()), name };
      if (file.bytes.length === 0) return badRequest('The file is empty.');
    } else {
      const parsed = await parseBody(req, EvidenceMetaSchema);
      if (!parsed.ok) return parsed.response;
      meta = parsed.data;
      if (meta.kind === 'file') return badRequest('Send a file as multipart/form-data.');
      if (meta.kind === 'link' && !/^https:\/\//i.test(meta.url ?? '')) return badRequest('A link must be an https:// address.');
      if (meta.kind === 'note' && meta.description.length < 20) return badRequest('A written note needs a description of at least 20 characters: it is the evidence.');
    }
    if (meta.collectedAt > today()) return badRequest('The evidence date cannot be in the future.');
    if (meta.validUntil && meta.validUntil < meta.collectedAt) return badRequest('"Valid until" cannot be before the date the evidence was produced.');
    const bad = checkControlKeys(meta.controls);
    if (bad) return badRequest(bad);

    const row = await readinessRepository.addEvidence(caller.projectId, {
      title: meta.title, description: meta.description, kind: meta.kind, origin: meta.origin, collectedAt: meta.collectedAt, validUntil: meta.validUntil ?? null,
      url: meta.kind === 'link' ? meta.url ?? null : null, fileName: file?.name ?? null, mimeType: null, uploadedBy: caller.email, controls: meta.controls,
      ...(file ? { file: { bytes: file.bytes, sha256: sha256Of(file.bytes) } } : {}),
    });
    await readinessRepository.clearSignoffs(caller.projectId, caller.framework);
    return created({ evidence: present(row), signoffsCleared: true });
  } catch (err) {
    console.error('[POST readiness evidence]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
