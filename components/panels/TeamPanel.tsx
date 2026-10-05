'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Users, UserPlus, Copy, Check, Loader2, ShieldCheck, Mail, Clock } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';

interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

interface PendingInvite {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
}

export default function TeamPanel() {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const isAdmin = state.currentUser?.role === 'admin';

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);
  const [lastAcceptUrl, setLastAcceptUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [membersRes, invitesRes] = await Promise.all([
        fetch('/api/admin/users', { credentials: 'include' }),
        isAdmin ? fetch('/api/auth/invite', { credentials: 'include' }) : Promise.resolve(null),
      ]);

      if (membersRes.ok) {
        const data = await membersRes.json();
        setMembers(data.data?.users ?? []);
      }
      if (invitesRes?.ok) {
        const data = await invitesRes.json();
        setInvites(data.data?.invites ?? []);
      }
    } catch {
      setError('Failed to load team data');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const [lastEmailSent, setLastEmailSent] = useState<boolean | null>(null);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setError(null);
    setLastAcceptUrl(null);
    setLastEmailSent(null);
    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Failed to send invite');
      setLastAcceptUrl(data.data.acceptUrl);
      setLastEmailSent(data.data.emailSent ?? false);
      setInviteEmail('');
      refresh();
    } catch (err: any) {
      setError(err.message ?? 'Failed to send invite');
    } finally {
      setInviting(false);
    }
  };

  const copyLink = (url: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className={clsx("flex-1 overflow-y-auto px-4 sm:px-8 py-8 pb-36 custom-scrollbar", isLight ? "bg-slate-50 text-slate-900" : "bg-gray-950 text-slate-100")}>
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className={clsx("text-xl font-bold flex items-center gap-2", isLight ? "text-slate-900" : "text-white")}>
            <Users className={clsx("w-5 h-5", isLight ? "text-blue-600" : "text-blue-400")} />
            Team
          </h1>
          <p className={clsx("text-sm mt-1", isLight ? "text-slate-500" : "text-gray-400")}>Manage who has access to this organization.</p>
        </div>

        {error && (
          <div className={clsx("p-3 rounded-xl border text-sm", isLight ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-rose-950/40 border-rose-500/30 text-rose-300")}>{error}</div>
        )}

        {isAdmin && (
          <div className={clsx("border rounded-2xl p-5", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-900 border-gray-800")}>
            <div className="flex items-center justify-between mb-3">
              <h2 className={clsx("text-sm font-semibold flex items-center gap-2", isLight ? "text-slate-900" : "text-white")}>
                <UserPlus className={clsx("w-4 h-4", isLight ? "text-blue-600" : "text-blue-400")} />
                Invite a teammate
              </h2>
              <span className={clsx(
                "text-[10px] border px-2 py-0.5 rounded font-mono font-medium",
                isLight ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-blue-950 text-blue-400 border-blue-800/60"
              )}>
                AWS SES Outbound
              </span>
            </div>
            <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[220px]">
                <label className={clsx("text-xs block mb-1 font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Email</label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className={clsx(
                    "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400" : "bg-gray-950 border-gray-800 text-white placeholder-gray-600"
                  )}
                />
              </div>
              <div>
                <label className={clsx("text-xs block mb-1 font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                  className={clsx(
                    "rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-950 border-gray-800 text-white"
                  )}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={inviting || !inviteEmail.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg disabled:opacity-50 flex items-center gap-2 shadow-sm transition-colors"
              >
                {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                Send Invite
              </button>
            </form>

            {lastAcceptUrl && (
              <div className={clsx(
                "mt-4 p-4 rounded-xl border text-xs space-y-2",
                isLight ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-blue-950/30 border-blue-500/30 text-blue-200"
              )}>
                <div className="flex items-center gap-2">
                  <Check className={clsx("w-4 h-4 shrink-0", isLight ? "text-emerald-600" : "text-emerald-400")} />
                  <span className={clsx("font-semibold", isLight ? "text-slate-900" : "text-white")}>
                    {lastEmailSent
                      ? 'Invitation email delivered via AWS SES!'
                      : 'Invite created. Share this link directly with your teammate:'}
                  </span>
                </div>
                <div className={clsx("flex items-center gap-2 border rounded-lg px-3 py-2", isLight ? "bg-white border-blue-200" : "bg-gray-950 border-gray-800")}>
                  <span className={clsx("truncate flex-1 font-mono", isLight ? "text-slate-800" : "text-gray-300")}>{lastAcceptUrl}</span>
                  <button onClick={() => copyLink(lastAcceptUrl)} className={clsx("transition-colors shrink-0", isLight ? "text-slate-500 hover:text-slate-900" : "text-gray-400 hover:text-white")}>
                    {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className={clsx("border rounded-2xl p-5", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-900 border-gray-800")}>
          <h2 className={clsx("text-sm font-semibold mb-3", isLight ? "text-slate-900" : "text-white")}>Members</h2>
          {loading ? (
            <div className={clsx("flex items-center gap-2 text-sm py-4", isLight ? "text-slate-500" : "text-gray-500")}>
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : (
            <div className="space-y-1.5">
              {members.map((m) => (
                <div key={m.userId} className={clsx("flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors", isLight ? "hover:bg-slate-50" : "hover:bg-gray-800/50")}>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={clsx(
                      "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                      isLight ? "bg-blue-100 text-blue-700" : "bg-blue-900/50 text-blue-300"
                    )}>
                      {(m.name || m.email).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className={clsx("text-sm font-medium truncate", isLight ? "text-slate-900" : "text-white")}>{m.name || m.email}</p>
                      <p className={clsx("text-xs truncate", isLight ? "text-slate-500" : "text-gray-500")}>{m.email}</p>
                    </div>
                  </div>
                  <span className={clsx(
                    'text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0',
                    ['owner', 'admin'].includes(m.role) 
                      ? (isLight ? 'bg-cyan-100 text-cyan-800 border border-cyan-200' : 'bg-cyan-900/40 text-cyan-300') 
                      : (isLight ? 'bg-slate-100 text-slate-700 border border-slate-200' : 'bg-gray-800 text-gray-400')
                  )}>
                    {['owner', 'admin'].includes(m.role) && <ShieldCheck className="w-3 h-3" />}
                    {m.role}
                  </span>
                </div>
              ))}
              {members.length === 0 && <p className={clsx("text-sm py-2", isLight ? "text-slate-500" : "text-gray-500")}>No members found.</p>}
            </div>
          )}
        </div>

        {isAdmin && invites.length > 0 && (
          <div className={clsx("border rounded-2xl p-5", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-900 border-gray-800")}>
            <h2 className={clsx("text-sm font-semibold mb-3", isLight ? "text-slate-900" : "text-white")}>Pending invites</h2>
            <div className="space-y-1.5">
              {invites.map((inv) => (
                <div key={inv.id} className={clsx("flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors", isLight ? "hover:bg-slate-50" : "hover:bg-gray-800/50")}>
                  <div className={clsx("flex items-center gap-2.5 text-sm font-medium", isLight ? "text-slate-800" : "text-gray-300")}>
                    <Mail className={clsx("w-3.5 h-3.5", isLight ? "text-slate-400" : "text-gray-500")} />
                    {inv.email}
                    <span className={clsx("text-xs font-normal", isLight ? "text-slate-500" : "text-gray-600")}>({inv.role})</span>
                  </div>
                  <span className={clsx("text-xs flex items-center gap-1", isLight ? "text-slate-500" : "text-gray-500")}>
                    <Clock className="w-3 h-3" />
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
