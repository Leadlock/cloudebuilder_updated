/**
 * The status route remembers, for a short time, whether a person may run Terraform for an organization. Deciding on an organization's access must
 * make the new answer visible at once, so the cache lives here where both the status route and the decision code can reach it.
 */
import { TtlCache } from '@/lib/api/ttlCache';

export const statusAccessCache = new TtlCache<{ denied: string | null }>(30_000, 1000);
