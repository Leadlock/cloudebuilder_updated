'use client';
/**
 * Read-only API keys for the organization's architecture templates: make one for another system (a marketplace, a script), see when each was last
 * used, and revoke it. A key is shown once, when it is made; after that only its first characters are known. Administrators only (the server checks).
 */
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import type { ApiKeyRecord } from '@/lib/apiKeys/keys';

async function call<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: body?.error?.message ?? 'The request failed.' };
    return { ok: true, data: body.data as T };
  } catch { return { ok: false, message: 'Could not reach the server.' }; }
}

const status = (k: ApiKeyRecord) => (k.revokedAt ? 'revoked' : k.expiresAt && Date.parse(k.expiresAt) <= Date.now() ? 'expired' : 'active');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export default function ApiKeysCard({ isLight }: { isLight: boolean }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [builtin, setBuiltin] = useState(true);
  const [own, setOwn] = useState(true);
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const r = await call<{ keys: ApiKeyRecord[] }>('/api/api-keys');
    if (r.ok) { setKeys(r.data.keys); setError(null); } else setError(r.message);
  }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setFresh(null); setCopied(false);
    const r = await call<{ key: string }>('/api/api-keys', { method: 'POST', body: JSON.stringify({ name, includeBuiltin: builtin, includeOwn: own, ...(days ? { expiresInDays: Number(days) } : {}) }) });
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    setFresh(r.data.key); setName('');
    await load();
  }

  async function revoke(k: ApiKeyRecord) {
    if (typeof window !== 'undefined' && !window.confirm(`Revoke the key "${k.name}"? Whatever uses it stops working at once.`)) return;
    const r = await call<{ revoked: boolean }>(`/api/api-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
    if (!r.ok) setError(r.message); else await load();
  }

  const muted = isLight ? 'text-slate-500' : 'text-gray-400';
  const input = clsx('rounded-lg border px-3 py-2 text-sm', isLight ? 'bg-white border-slate-300' : 'bg-gray-950 border-gray-700');
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-server';

  return (
    <div className="mb-5" data-testid="api-keys">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={clsx('px-3 py-1.5 rounded-lg text-xs font-semibold border', isLight ? 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100' : 'bg-gray-900 border-gray-800 text-gray-200 hover:bg-gray-800')}>
        API keys for other systems {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className={clsx('mt-2 rounded-xl border p-4 space-y-3 max-w-3xl', isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-gray-800')}>
          <p className={clsx('text-xs', muted)}>A read-only key lets another system (a marketplace, a script) read your organization&apos;s templates, and nothing else. It is shown once. Revoke it here at any time.</p>

          <form onSubmit={create} className="space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <input aria-label="Key name" placeholder="Name, for example Neozaar marketplace" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={clsx(input, 'flex-1 min-w-[14rem]')} />
              <select aria-label="Expires" value={days} onChange={(e) => setDays(e.target.value)} className={input}>
                <option value="30">Expires in 30 days</option><option value="90">Expires in 90 days</option><option value="365">Expires in a year</option><option value="">Never expires</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={builtin} onChange={(e) => setBuiltin(e.target.checked)} />Can read the built-in templates</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />Can read our own templates</label>
            </div>
            <button type="submit" disabled={busy || !name.trim() || (!builtin && !own)} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white disabled:opacity-40">{busy ? 'Creating…' : 'Create key'}</button>
          </form>

          {fresh && (
            <div role="status" className={clsx('rounded-lg border p-3 space-y-2', isLight ? 'border-emerald-300 bg-emerald-50' : 'border-emerald-500/40 bg-emerald-500/10')} data-testid="new-key">
              <p className="text-xs font-semibold">Copy the key now. It is not shown again.</p>
              <code className="block break-all rounded bg-black/20 px-2 py-1.5 text-xs">{fresh}</code>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(fresh); setCopied(true); }} className="px-2.5 py-1 rounded-lg text-xs border border-emerald-500/50">{copied ? 'Copied' : 'Copy'}</button>
              <p className={clsx('text-[11px]', muted)}>Use it like this:</p>
              <code className="block break-all rounded bg-black/20 px-2 py-1.5 text-[11px]">curl -H &quot;Authorization: Bearer {fresh}&quot; &quot;{origin}/api/public/templates?graphs=1&quot;</code>
            </div>
          )}
          {error && <p role="alert" className="text-xs text-rose-500">{error}</p>}

          {keys && keys.length === 0 && <p className={clsx('text-xs', muted)}>No keys yet.</p>}
          {keys && keys.length > 0 && (
            <table className="w-full text-xs">
              <thead><tr className={muted}><th className="text-left font-medium py-1">Name</th><th className="text-left font-medium">Key</th><th className="text-left font-medium">Reads</th><th className="text-left font-medium">Last used</th><th className="text-left font-medium">Status</th><th /></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-t border-gray-800/40">
                    <td className="py-1.5">{k.name}</td>
                    <td className="font-mono">{k.keyPrefix}…</td>
                    <td>{[k.includeBuiltin && 'built-in', k.includeOwn && 'ours'].filter(Boolean).join(' + ')}</td>
                    <td>{day(k.lastUsedAt)}</td>
                    <td>{status(k)}{k.expiresAt && status(k) === 'active' ? ` (until ${day(k.expiresAt)})` : ''}</td>
                    <td className="text-right">{status(k) === 'active' && <button type="button" onClick={() => void revoke(k)} className="text-rose-500 underline">Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
