'use client';
/**
 * Authenticator-app confirmation: set it up, see that it is on, turn it off. Once on, confirming a deploy or teardown needs the
 * password and the 6-digit code. The secret and the recovery codes are shown once, here, and kept nowhere in the browser.
 */
import { useCallback, useEffect, useState } from 'react';
import { Smartphone, Loader2 } from 'lucide-react';

type Phase = 'off' | 'scan' | 'codes' | 'on';
const INPUT = 'bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-xs placeholder-gray-500 focus:outline-none focus:border-amber-500';
const BUTTON = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-600 text-gray-200 hover:bg-gray-700 disabled:opacity-50';

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; message?: string }> {
  const res = await fetch('/api/account/totp', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({})) as { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
  return res.ok && json.ok ? { ok: true, data: json.data } : { ok: false, message: json.error?.message ?? 'That did not work.' };
}

export default function TotpCard() {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [recoveryLeft, setRecoveryLeft] = useState(0);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [turningOff, setTurningOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/totp', { credentials: 'include' });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; data?: { enabled: boolean; recoveryCodesLeft: number } };
      if (res.ok && json.ok && json.data) { setPhase(json.data.enabled ? 'on' : 'off'); setRecoveryLeft(json.data.recoveryCodesLeft); }
    } catch { /* card stays hidden */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Network error'); } finally { setBusy(false); setPassword(''); setCode(''); }
  }

  const begin = () => run(async () => {
    const r = await post({ action: 'begin', password });
    if (!r.ok) { setError(r.message ?? null); return; }
    setSetup(r.data as { secret: string; uri: string }); setPhase('scan');
  });
  const enable = () => run(async () => {
    const r = await post({ action: 'enable', code });
    if (!r.ok) { setError(r.message ?? null); return; }
    setRecovery((r.data as { recoveryCodes: string[] }).recoveryCodes); setSetup(null); setPhase('codes');
  });
  const disable = () => run(async () => {
    const r = await post({ action: 'disable', password, code });
    if (!r.ok) { setError(r.message ?? null); return; }
    setTurningOff(false); setPhase('off');
  });

  if (phase === null) return null;

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 space-y-3" aria-label="Authenticator app" data-testid="totp-card">
      <div className="flex items-center gap-2 text-gray-200 text-sm font-semibold"><Smartphone className="w-4 h-4 text-amber-400" /> Authenticator app for deploy and teardown</div>

      {phase === 'off' && (
        <div className="space-y-2">
          <p className="text-gray-400 text-xs leading-relaxed">Optional. Once on, confirming a deploy or teardown needs your password <strong>and</strong> a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…), so a leaked password alone is not enough.</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (password) void begin(); }}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" aria-label="Your password" className={`${INPUT} flex-1 min-w-0`} />
            <button type="submit" className={BUTTON} disabled={busy || !password}>{busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Set up'}</button>
          </form>
        </div>
      )}

      {phase === 'scan' && setup && (
        <div className="space-y-2 text-xs">
          <p className="text-gray-300 leading-relaxed">In your authenticator app choose <strong>Add account → Enter a setup key</strong>, and type this key (time-based, 6 digits):</p>
          <code className="block font-mono text-gray-100 bg-gray-900/70 rounded-lg px-3 py-2 break-all select-all" data-testid="totp-secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
          <p className="text-gray-500">On a phone you can also <a href={setup.uri} className="text-amber-300 underline">open the setup link</a>. It is shown once and CloudCraft cannot show it again.</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code) void enable(); }}>
            <input type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from the app" autoComplete="one-time-code" aria-label="Code from the app" maxLength={8} className={`${INPUT} flex-1 min-w-0`} />
            <button type="submit" className={BUTTON} disabled={busy || !code}>{busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Turn on'}</button>
          </form>
        </div>
      )}

      {phase === 'codes' && (
        <div className="space-y-2 text-xs rounded-lg border border-amber-800/40 bg-amber-950/20 p-3" data-testid="recovery-codes">
          <p className="text-amber-200 font-medium">It is on. Save these recovery codes now: each works once if you lose your phone, and they will not be shown again.</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-gray-100 select-all">{recovery.map((c) => <li key={c}>{c}</li>)}</ul>
          <button type="button" className={BUTTON} onClick={() => { setRecovery([]); setPhase('on'); setRecoveryLeft(8); }}>I have saved them</button>
        </div>
      )}

      {phase === 'on' && (
        <div className="space-y-2 text-xs">
          <p className="text-emerald-400">On. Deploys and teardowns need your password and a code. {recoveryLeft} recovery code{recoveryLeft === 1 ? '' : 's'} left.</p>
          {turningOff ? (
            <form className="flex gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); if (password && code) void disable(); }}>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" aria-label="Your password" className={`${INPUT} flex-1 min-w-0`} />
              <input type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="App or recovery code" aria-label="App or recovery code" className={`${INPUT} w-40`} />
              <button type="submit" className={BUTTON} disabled={busy || !password || !code}>{busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Turn off'}</button>
              <button type="button" className={BUTTON} onClick={() => { setTurningOff(false); setError(null); }}>Cancel</button>
            </form>
          ) : (
            <button type="button" className={BUTTON} onClick={() => setTurningOff(true)}>Turn off…</button>
          )}
        </div>
      )}
      {error && <p className="text-red-400 text-xs" role="alert">{error}</p>}
    </section>
  );
}
