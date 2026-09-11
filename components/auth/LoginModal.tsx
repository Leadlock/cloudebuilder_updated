'use client';

import React, { useState } from 'react';
import { ShieldCheck, UserCheck, Lock, Mail, AlertCircle, Loader2 } from 'lucide-react';
import type { AuthUser } from '@/lib/api/authService';

interface LoginModalProps {
  isOpen: boolean;
  onSuccess: (user: AuthUser) => void;
  onClose?: () => void;
}

export default function LoginModal({ isOpen, onSuccess, onClose }: LoginModalProps) {
  const [email, setEmail] = useState('admin@cloudcraft.io');
  const [password, setPassword] = useState('Admin123!');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? 'Invalid email or password');
      }

      onSuccess(data.user);
      if (onClose) onClose();
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  const selectPreset = (presetEmail: string, presetPass: string) => {
    setEmail(presetEmail);
    setPassword(presetPass);
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">CloudCraft Authentication</h2>
              <p className="text-xs text-slate-400">Enterprise Cloud Architecture Intelligence</p>
            </div>
          </div>
        </div>

        {/* Preset quick buttons */}
        <div className="p-6 space-y-4">
          <div>
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">
              Select Role / Quick Login
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => selectPreset('admin@cloudcraft.io', 'Admin123!')}
                className={`flex flex-col items-start p-3 rounded-xl border text-left transition-all ${
                  email === 'admin@cloudcraft.io'
                    ? 'border-cyan-500/60 bg-cyan-950/40 text-cyan-300 ring-1 ring-cyan-500/50'
                    : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-1.5 font-bold text-xs mb-1">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  ADMIN
                </div>
                <span className="text-[10px] text-slate-400">Approve & Deploy</span>
              </button>

              <button
                type="button"
                onClick={() => selectPreset('user@cloudcraft.io', 'User123!')}
                className={`flex flex-col items-start p-3 rounded-xl border text-left transition-all ${
                  email === 'user@cloudcraft.io'
                    ? 'border-indigo-500/60 bg-indigo-950/40 text-indigo-300 ring-1 ring-indigo-500/50'
                    : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-1.5 font-bold text-xs mb-1">
                  <UserCheck className="w-4 h-4 text-indigo-400" />
                  USER
                </div>
                <span className="text-[10px] text-slate-400">Design & Submit</span>
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs text-slate-300 font-medium block mb-1">Work Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                  placeholder="name@company.com"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-300 font-medium block mb-1">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-white font-semibold text-xs transition-colors flex items-center justify-center gap-2 shadow-lg shadow-cyan-600/20 disabled:opacity-50 mt-4"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Authenticating...
                </>
              ) : (
                `Sign In as ${email === 'admin@cloudcraft.io' ? 'Administrator' : 'Standard User'}`
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
