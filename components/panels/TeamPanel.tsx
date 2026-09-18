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

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setError(null);
    setLastAcceptUrl(null);
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
    <div className="flex-1 overflow-y-auto p-8 bg-gray-950">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-400" />
            Team
          </h1>
          <p className="text-sm text-gray-400 mt-1">Manage who has access to this organization.</p>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-300 text-sm">{error}</div>
        )}

        {isAdmin && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
              <UserPlus className="w-4 h-4 text-blue-400" />
              Invite a teammate
            </h2>
            <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[220px]">
                <label className="text-xs text-gray-400 block mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                  className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={inviting || !inviteEmail.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg disabled:opacity-50 flex items-center gap-2"
              >
                {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                Send Invite
              </button>
            </form>

            {lastAcceptUrl && (
              <div className="mt-4 p-3 rounded-xl bg-blue-950/30 border border-blue-500/30 text-xs text-blue-200">
                <p className="mb-2">No email sending is wired up yet — share this link with them directly:</p>
                <div className="flex items-center gap-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
                  <span className="truncate flex-1 font-mono text-gray-300">{lastAcceptUrl}</span>
                  <button onClick={() => copyLink(lastAcceptUrl)} className="text-gray-400 hover:text-white shrink-0">
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-white mb-3">Members</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-gray-500 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : (
            <div className="space-y-1.5">
              {members.map((m) => (
                <div key={m.userId} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-800/50">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-blue-900/50 flex items-center justify-center text-blue-300 text-xs font-bold shrink-0">
                      {(m.name || m.email).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{m.name || m.email}</p>
                      <p className="text-xs text-gray-500 truncate">{m.email}</p>
                    </div>
                  </div>
                  <span className={clsx(
                    'text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0',
                    ['owner', 'admin'].includes(m.role) ? 'bg-cyan-900/40 text-cyan-300' : 'bg-gray-800 text-gray-400'
                  )}>
                    {['owner', 'admin'].includes(m.role) && <ShieldCheck className="w-3 h-3" />}
                    {m.role}
                  </span>
                </div>
              ))}
              {members.length === 0 && <p className="text-sm text-gray-500 py-2">No members found.</p>}
            </div>
          )}
        </div>

        {isAdmin && invites.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Pending invites</h2>
            <div className="space-y-1.5">
              {invites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-800/50">
                  <div className="flex items-center gap-2.5 text-sm text-gray-300">
                    <Mail className="w-3.5 h-3.5 text-gray-500" />
                    {inv.email}
                    <span className="text-xs text-gray-600">({inv.role})</span>
                  </div>
                  <span className="text-xs text-gray-500 flex items-center gap-1">
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
