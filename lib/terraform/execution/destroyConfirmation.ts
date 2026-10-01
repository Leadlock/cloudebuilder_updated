/**
 * Two-step confirmation for `terraform destroy`.
 *
 * Destroy deletes real infrastructure in one request, so the server — not just the browser — requires an explicit second
 * step. The first request returns a PREVIEW (what would be removed) and a short-lived confirmation token; only a second
 * request carrying that token runs the destroy. The token is signed, expires after five minutes, can be used once, and
 * is bound to the exact user, organisation, project, environment, cloud account, state backend and list of resources
 * that were previewed — change any of those and the token no longer matches, so a stale or replayed token cannot delete
 * something the user did not see.
 *
 * Used tokens are remembered in this server process (see authService.ts for the multi-instance caveat).
 */
import { createHash, randomUUID } from 'crypto';
import { encodeSessionToken, decodeSessionToken } from '@/lib/crypto/sessionToken';

const KIND = 'destroy-confirm';
export const DESTROY_CONFIRM_TTL_MS = 5 * 60_000;

export interface DestroyBinding {
  userId: string;
  orgId: string;
  projectId: string;
  environment: string;
  cloudAccountId: string;
  stateBackend: unknown;
  /** What the destroy would remove, as seen in the preview. */
  resources: { id: string; resourceType: string }[];
}

interface ConfirmPayload { kind: typeof KIND; jti: string; exp: number; bind: string }

const used = new Map<string, number>(); // jti → expiry

function bindingHash(b: DestroyBinding): string {
  const resources = [...b.resources].sort((x, y) => x.id.localeCompare(y.id)).map((r) => `${r.id}:${r.resourceType}`);
  return createHash('sha256').update(JSON.stringify([b.userId, b.orgId, b.projectId, b.environment, b.cloudAccountId, b.stateBackend, resources])).digest('hex');
}

function prune(now: number): void {
  for (const [jti, exp] of used) if (exp < now) used.delete(jti);
}

export function issueDestroyConfirmation(binding: DestroyBinding): { token: string; expiresAt: string } {
  const exp = Date.now() + DESTROY_CONFIRM_TTL_MS;
  const payload: ConfirmPayload = { kind: KIND, jti: randomUUID(), exp, bind: bindingHash(binding) };
  return { token: encodeSessionToken(payload as unknown as Record<string, unknown>), expiresAt: new Date(exp).toISOString() };
}

export type DestroyConfirmationResult = { ok: true } | { ok: false; reason: string };

/** Checks the token against what is about to be destroyed and, if valid, uses it up. */
export function consumeDestroyConfirmation(token: string, binding: DestroyBinding): DestroyConfirmationResult {
  const now = Date.now();
  prune(now);
  const payload = decodeSessionToken<ConfirmPayload>(token);
  if (!payload || payload.kind !== KIND || typeof payload.jti !== 'string' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'The confirmation is not valid. Request a new one.' };
  }
  if (now > payload.exp) return { ok: false, reason: 'The confirmation has expired. Request a new one.' };
  if (used.has(payload.jti)) return { ok: false, reason: 'This confirmation has already been used. Request a new one.' };
  if (payload.bind !== bindingHash(binding)) {
    return { ok: false, reason: 'What would be destroyed has changed since you reviewed it (or this confirmation is for something else). Review it again.' };
  }
  used.set(payload.jti, payload.exp);
  return { ok: true };
}
