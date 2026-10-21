/** GET /api/public/templates/[id] — one template with its graph, read with an API key (see ../route.ts). A template the key may not see is a 404. */
import { NextRequest } from 'next/server';
import { ok, internalError, notFound } from '@/lib/api/response';
import { authenticateApiKey } from '@/lib/apiKeys/auth';
import { SCOPE_TEMPLATES_READ } from '@/lib/apiKeys/keys';
import { PgApiKeyStore } from '@/lib/apiKeys/store';
import { PgTemplateStore } from '@/lib/templates/templateStore';
import { publicTemplate } from '@/lib/apiKeys/publicTemplate';

export const dynamic = 'force-dynamic';

const keys = new PgApiKeyStore();
const templates = new PgTemplateStore();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticateApiKey(req, SCOPE_TEMPLATES_READ, keys);
    if (!auth.ok) return auth.response;
    const { key } = auth;
    const t = await templates.get(key.orgId, (await params).id);
    if (!t || (t.source === 'builtin' ? !key.includeBuiltin : !key.includeOwn)) return notFound('Template');
    const res = ok({ template: publicTemplate(t, t.graph) });
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  } catch (err) {
    console.error('[GET public/templates/:id]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
