/**
 * GET /api/public/templates — read the architecture templates with an API key (`Authorization: Bearer cb_…` or `X-API-Key: cb_…`). Read-only.
 *
 * Gives the templates the key was made to see (the built-in ones, the organization's own, or both): name, description, provider, category, tags, features
 * and the other descriptive fields. Add `?graphs=1` to include each template's resources and connections (a full export). `?provider=aws|azure|multi`
 * and `?category=…` filter. The key can read nothing else.
 *
 * `?format=neozaar` gives each template as the body of Neozaar's Create Service request, with what is still missing and what to review (graphs are always
 * read for it). `?ready=1` keeps only the ones with nothing missing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ok, internalError } from '@/lib/api/response';
import { authenticateApiKey } from '@/lib/apiKeys/auth';
import { SCOPE_TEMPLATES_READ } from '@/lib/apiKeys/keys';
import { PgApiKeyStore } from '@/lib/apiKeys/store';
import { PgTemplateStore } from '@/lib/templates/templateStore';
import { syncBuiltInTemplates } from '@/lib/templates/sync';
import { publicTemplate } from '@/lib/apiKeys/publicTemplate';
import { PgListingStore } from '@/lib/marketplace/listingStore';
import { toNeozaarService } from '@/lib/marketplace/neozaar';
import type { StoredTemplate, StoredTemplateWithGraph } from '@/lib/templates/stored';

export const dynamic = 'force-dynamic';

const keys = new PgApiKeyStore();
const templates = new PgTemplateStore();
const listings = new PgListingStore();

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateApiKey(req, SCOPE_TEMPLATES_READ, keys);
    if (!auth.ok) return auth.response;
    const { key } = auth;
    const url = new URL(req.url);
    const neozaar = url.searchParams.get('format') === 'neozaar';
    const withGraphs = url.searchParams.get('graphs') === '1' || neozaar;
    const provider = url.searchParams.get('provider');
    const category = url.searchParams.get('category');

    const read = (): Promise<Array<StoredTemplate & { graph?: StoredTemplateWithGraph['graph'] }>> => (withGraphs ? templates.listWithGraphs(key.orgId) : templates.list(key.orgId));
    let list = await read();
    if (key.includeBuiltin && !list.some((t) => t.source === 'builtin')) { await syncBuiltInTemplates(templates); list = await read(); }
    list = list.filter((t) => (t.source === 'builtin' ? key.includeBuiltin : key.includeOwn) && (!provider || t.provider === provider) && (!category || t.category === category));
    if (neozaar) {
      const saved = await listings.forOrg(key.orgId);
      let items = list.map((t) => toNeozaarService(publicTemplate(t, t.graph ?? null), saved.get(t.id) ?? {}));
      const total = items.length; const readyCount = items.filter((i) => i.ready).length;
      if (url.searchParams.get('ready') === '1') items = items.filter((i) => i.ready);
      const res: NextResponse = ok({ count: items.length, total, readyCount, templates: items });
      res.headers.set('Cache-Control', 'private, no-store');
      return res;
    }
    const out = list.map((t) => publicTemplate(t, t.graph ?? null));
    const res: NextResponse = ok({ count: out.length, templates: out });
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  } catch (err) {
    console.error('[GET public/templates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
