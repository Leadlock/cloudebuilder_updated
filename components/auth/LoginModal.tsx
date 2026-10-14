'use client';

import React, { useState, useEffect } from 'react';
import { ShieldCheck, Lock, Mail, User as UserIcon, Building2, AlertCircle, Loader2, KeyRound, ArrowLeft, RefreshCw, CheckCircle2, Copy, Check, Smartphone, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import type { AuthUser } from '@/lib/api/authService';
import { useApp } from '@/context/AppContext';

interface LoginModalProps {
  isOpen: boolean;
  onSuccess: (user: AuthUser) => void;
  onClose?: () => void;
}

export default function LoginModal({ isOpen, onSuccess, onClose }: LoginModalProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  const [mode, setMode] = useState<'signin' | 'signup' | 'confirm' | 'mfa' | 'forgot_password' | 'reset_password'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [code, setCode] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaSession, setMfaSession] = useState('');
  const [mfaChallengeName, setMfaChallengeName] = useState<'app' | 'sms' | 'email' | 'setup'>('app');
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [showManualKey, setShowManualKey] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  useEffect(() => {
    if (mfaSecret && email) {
      const otpauthUri = `otpauth://totp/CloudCraft:${encodeURIComponent(email)}?secret=${mfaSecret}&issuer=CloudCraft`;
      QRCode.toDataURL(otpauthUri, {
        margin: 1,
        width: 180,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      })
        .then((url) => setQrCodeUrl(url))
        .catch((err) => console.error('Failed to generate QR Code:', err));
    } else {
      setQrCodeUrl(null);
    }
  }, [mfaSecret, email]);

  if (!isOpen) return null;

  const inputClass = `w-full rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors ${
    isLight
      ? 'bg-slate-50 border border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white'
      : 'bg-slate-950 border border-slate-800 text-white placeholder-slate-500'
  }`;

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setLoading(true);
    setError(null);
    setInfoMessage(null);

    // 1. Account Confirmation
    if (mode === 'confirm') {
      try {
        const res = await fetch('/api/auth/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, code, name, orgName }),
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error?.message ?? data.error ?? data.message ?? 'Verification failed');
        }

        onSuccess(data.user);
        if (onClose) onClose();
      } catch (err: any) {
        setError(err.message || 'Verification failed');
      } finally {
        setLoading(false);
      }
      return;
    }

    // 2. MFA Challenge
    if (mode === 'mfa') {
      try {
        const res = await fetch('/api/auth/mfa/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            email,
            session: mfaSession,
            method: mfaChallengeName,
            code: mfaCode,
          }),
        });

        const data = await res.json();

        if (data.requiresMfa) {
          setMfaSession(data.session);
          setMfaChallengeName(data.method || 'app');
          setInfoMessage(data.message || 'Additional verification required.');
          return;
        }

        if (!res.ok || !data.success) {
          throw new Error(data.error?.message ?? data.error ?? data.message ?? 'Verification failed');
        }

        onSuccess(data.user);
        if (onClose) onClose();
      } catch (err: any) {
        setError(err.message || 'Verification failed');
      } finally {
        setLoading(false);
      }
      return;
    }

    // 3. Forgot Password Request
    if (mode === 'forgot_password') {
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
        });

        const data = await res.json();
        if (!res.ok || data.ok === false) {
          throw new Error(data.error?.message ?? data.error ?? data.message ?? 'Failed to send password reset code');
        }

        setMode('reset_password');
        setInfoMessage(data.data?.message ?? data.message ?? `A verification code was sent to ${email}. Enter the code and your new password below.`);
      } catch (err: any) {
        setError(err.message || 'Failed to send reset code');
      } finally {
        setLoading(false);
      }
      return;
    }

    // 4. Reset Password Confirmation
    if (mode === 'reset_password') {
      if (newPassword !== confirmNewPassword) {
        setError('New passwords do not match. Please verify.');
        setLoading(false);
        return;
      }

      if (newPassword.length < 8) {
        setError('Password must be at least 8 characters.');
        setLoading(false);
        return;
      }

      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            code: resetCode.trim(),
            newPassword,
          }),
        });

        const data = await res.json();
        if (!res.ok || data.ok === false) {
          throw new Error(data.error?.message ?? data.error ?? data.message ?? 'Failed to reset password');
        }

        setPassword(newPassword);
        setMode('signin');
        setInfoMessage(data.data?.message ?? data.message ?? 'Password reset successfully! You can now sign in with your new password.');
      } catch (err: any) {
        setError(err.message || 'Failed to reset password');
      } finally {
        setLoading(false);
      }
      return;
    }

    // 5. Sign In or Sign Up
    const endpoint = mode === 'signin' ? '/api/auth/login' : '/api/auth/signup';
    const body = mode === 'signin' ? { email, password } : { email, password, name, orgName };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (data.requiresConfirmation) {
        setMode('confirm');
        setInfoMessage(data.message || `A verification code was sent to ${email}. Please enter it below.`);
        return;
      }

      if (data.requiresMfa) {
        setMode('mfa');
        setMfaSession(data.session);
        setMfaChallengeName(data.method || 'app');
        setInfoMessage(data.message || 'Please enter the 6-digit code from your authenticator app.');

        // If user needs to set up TOTP token for first time
        if (data.method === 'setup') {
          try {
            const setupRes = await fetch('/api/auth/mfa/setup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session: data.session }),
            });
            const setupData = await setupRes.json();
            if (setupData.success && setupData.secretCode) {
              setMfaSecret(setupData.secretCode);
              if (setupData.session) setMfaSession(setupData.session);
            }
          } catch (setupErr) {
            console.warn('Failed to load MFA setup secret:', setupErr);
          }
        }
        return;
      }

      if (!res.ok || !data.success) {
        throw new Error(data.error?.message ?? data.error ?? data.message ?? 'Something went wrong');
      }

      onSuccess(data.user);
      if (onClose) onClose();
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleResendCode() {
    if (!email) return;
    setResending(true);
    setError(null);
    try {
      if (mode === 'reset_password' || mode === 'forgot_password') {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message ?? data.error ?? 'Failed to resend reset code');
        }
        setInfoMessage('A fresh password reset code has been sent to your email.');
      } else {
        const res = await fetch('/api/auth/resend-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message ?? data.error ?? 'Failed to resend code');
        }
        setInfoMessage('A new verification code has been sent to your email.');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to resend code');
    } finally {
      setResending(false);
    }
  }

  function handleCopySecret() {
    if (!mfaSecret) return;
    navigator.clipboard.writeText(mfaSecret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  }

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${isLight ? 'bg-slate-900/40' : 'bg-slate-950/80'} backdrop-blur-sm p-4`}>
      <div className={`${isLight ? 'bg-white border-slate-200 shadow-2xl' : 'bg-slate-900 border-slate-800 shadow-2xl'} border rounded-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200`}>
        {/* Header */}
        <div className={`px-6 pt-6 pb-4 border-b ${isLight ? 'border-slate-100 bg-slate-50/60' : 'border-slate-800 bg-slate-900/60'}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
              {mode === 'forgot_password' || mode === 'reset_password' ? (
                <KeyRound className="w-5 h-5" />
              ) : (
                <Lock className="w-5 h-5" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className={`text-lg font-bold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>CloudCraft</h2>
                <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${
                  isLight ? 'bg-cyan-50 text-cyan-700 border-cyan-200' : 'bg-cyan-950 text-cyan-400 border-cyan-800/60'
                }`}>
                  Secure sign-in
                </span>
              </div>
              <p className={`text-xs ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                {mode === 'forgot_password' || mode === 'reset_password'
                  ? 'Password Recovery'
                  : 'Cloud Architecture Design & Governance'}
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Mode toggle (shown only in signin and signup modes) */}
          {mode === 'signin' || mode === 'signup' ? (
            <div className={`grid grid-cols-2 gap-1 p-1 rounded-xl border ${isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'}`}>
              <button
                type="button"
                onClick={() => { setMode('signin'); setError(null); setInfoMessage(null); }}
                className={`py-2 rounded-lg text-xs font-semibold transition-colors ${
                  mode === 'signin'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : isLight
                      ? 'text-slate-600 hover:text-slate-900'
                      : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => { setMode('signup'); setError(null); setInfoMessage(null); }}
                className={`py-2 rounded-lg text-xs font-semibold transition-colors ${
                  mode === 'signup'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : isLight
                      ? 'text-slate-600 hover:text-slate-900'
                      : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Create Account
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
                setInfoMessage(null);
                setMfaCode('');
                setMfaSecret(null);
              }}
              className={`flex items-center gap-1.5 text-xs ${isLight ? 'text-slate-600 hover:text-slate-900' : 'text-slate-400 hover:text-white'} transition-colors`}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Sign In
            </button>
          )}

          {infoMessage && (
            <div className={`flex items-center gap-2 p-3 rounded-xl border text-xs ${
              isLight ? 'bg-cyan-50 border-cyan-200 text-cyan-900' : 'bg-cyan-950/50 border-cyan-500/40 text-cyan-300'
            }`}>
              <CheckCircle2 className={`w-4 h-4 shrink-0 ${isLight ? 'text-cyan-600' : 'text-cyan-400'}`} />
              <span>{infoMessage}</span>
            </div>
          )}

          {error && (
            <div className={`flex items-center gap-2 p-3 rounded-xl border text-xs ${
              isLight ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-rose-950/50 border-rose-500/40 text-rose-300'
            }`}>
              <AlertCircle className={`w-4 h-4 shrink-0 ${isLight ? 'text-rose-600' : 'text-rose-400'}`} />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === 'forgot_password' ? (
              <div className="space-y-3">
                <div>
                  <h3 className={`text-sm font-semibold mb-1 ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    Forgot your password?
                  </h3>
                  <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
                    Enter your work email address and we&apos;ll send you a 6-digit verification code to reset your password.
                  </p>
                </div>

                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Work Email</label>
                  <div className="relative">
                    <Mail className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="email"
                      required
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={`${inputClass} pl-9`}
                      placeholder="name@company.com"
                    />
                  </div>
                </div>
              </div>
            ) : mode === 'reset_password' ? (
              <div className="space-y-3">
                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Account Email</label>
                  <input
                    type="email"
                    disabled
                    value={email}
                    className={`w-full rounded-xl px-3 py-2 text-xs cursor-not-allowed border ${
                      isLight ? 'bg-slate-100 border-slate-200 text-slate-500' : 'bg-slate-950/60 border-slate-800 text-slate-400'
                    }`}
                  />
                </div>

                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                    6-Digit Reset Code
                  </label>
                  <div className="relative">
                    <KeyRound className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="text"
                      required
                      autoFocus
                      maxLength={6}
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value.trim())}
                      className={`w-full border rounded-xl pl-9 pr-3 py-2 text-sm text-center tracking-widest font-mono focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 ${
                        isLight ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white' : 'bg-slate-950 border-slate-800 text-white placeholder-slate-500'
                      }`}
                      placeholder="123456"
                    />
                  </div>
                  <div className="flex justify-between items-center mt-1.5">
                    <span className={`text-[11px] ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>Check your inbox & spam folder</span>
                    <button
                      type="button"
                      disabled={resending}
                      onClick={handleResendCode}
                      className="text-[11px] text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${resending ? 'animate-spin' : ''}`} />
                      Resend Code
                    </button>
                  </div>
                </div>

                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>New Password</label>
                  <div className="relative">
                    <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className={`${inputClass} pl-9`}
                      placeholder="At least 8 characters"
                    />
                  </div>
                </div>

                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Confirm New Password</label>
                  <div className="relative">
                    <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      className={`${inputClass} pl-9`}
                      placeholder="Re-type new password"
                    />
                  </div>
                </div>
              </div>
            ) : mode === 'mfa' ? (
              <>
                <div className={`p-3.5 rounded-xl border ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800'} space-y-3`}>
                  <div className="flex items-center gap-2">
                    <Smartphone className={`w-4 h-4 ${isLight ? 'text-cyan-600' : 'text-cyan-400'}`} />
                    <span className={`text-xs font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>
                      {mfaChallengeName === 'sms'
                        ? 'SMS Verification'
                        : mfaChallengeName === 'email'
                        ? 'Email Verification'
                        : 'Authenticator App (TOTP)'}
                    </span>
                  </div>
                  <p className={`text-[11px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
                    {mfaChallengeName === 'sms'
                      ? 'Enter the 6-digit code sent to your mobile phone via SMS.'
                      : mfaChallengeName === 'email'
                      ? `Enter the 6-digit verification code sent to ${email}.`
                      : 'Scan the QR code with Google Authenticator, Microsoft Authenticator, or 1Password and enter your 6-digit code.'}
                  </p>

                  {/* QR Code Container */}
                  {qrCodeUrl && (
                    <div className="flex flex-col items-center justify-center pt-1 pb-1">
                      <div className="p-3 bg-white rounded-2xl shadow-md border border-slate-200 inline-block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={qrCodeUrl}
                          alt="Authenticator QR Code"
                          className="w-36 h-36 rounded-lg block"
                        />
                      </div>
                      <span className={`text-[10px] font-medium mt-1.5 flex items-center gap-1 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                        <QrCode className="w-3 h-3 text-cyan-500" />
                        Scan with your Authenticator App
                      </span>
                    </div>
                  )}

                  {/* Manual Key toggle */}
                  {mfaSecret && (
                    <div className="pt-1 border-t border-slate-200/80 dark:border-slate-800/80">
                      <button
                        type="button"
                        onClick={() => setShowManualKey(!showManualKey)}
                        className={`text-[11px] font-medium text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 transition-colors flex items-center gap-1`}
                      >
                        <KeyRound className="w-3 h-3" />
                        {showManualKey ? 'Hide manual setup key' : 'Cannot scan QR code? Enter key manually'}
                      </button>

                      {showManualKey && (
                        <div className="mt-2 space-y-1.5 animate-in fade-in duration-150">
                          <p className={`text-[10px] font-semibold uppercase tracking-wider ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                            Setup Key (Base32)
                          </p>
                          <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-black/5 dark:bg-black/40 font-mono text-xs select-all border border-slate-200 dark:border-slate-800">
                            <span className={`break-all ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>{mfaSecret}</span>
                            <button
                              type="button"
                              onClick={handleCopySecret}
                              className="shrink-0 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 transition-colors"
                              title="Copy Key"
                            >
                              {copiedSecret ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                    6-Digit Security Code
                  </label>
                  <div className="relative">
                    <KeyRound className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="text"
                      required
                      autoFocus
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={8}
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value.trim())}
                      className={`w-full border rounded-xl pl-9 pr-3 py-2.5 text-sm text-center tracking-widest font-mono font-bold focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 ${
                        isLight ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white' : 'bg-slate-950 border-slate-800 text-white placeholder-slate-500'
                      }`}
                      placeholder="000000"
                    />
                  </div>
                </div>
              </>
            ) : mode === 'confirm' ? (
              <>
                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Email</label>
                  <input
                    type="email"
                    disabled
                    value={email}
                    className={`w-full rounded-xl px-3 py-2 text-xs cursor-not-allowed border ${
                      isLight ? 'bg-slate-100 border-slate-200 text-slate-500' : 'bg-slate-950/60 border-slate-800 text-slate-400'
                    }`}
                  />
                </div>

                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>6-Digit Verification Code</label>
                  <div className="relative">
                    <KeyRound className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="text"
                      required
                      autoFocus
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.trim())}
                      className={`w-full border rounded-xl pl-9 pr-3 py-2 text-sm text-center tracking-widest font-mono focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 ${
                        isLight ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white' : 'bg-slate-950 border-slate-800 text-white placeholder-slate-500'
                      }`}
                      placeholder="123456"
                    />
                  </div>
                  <div className="flex justify-between items-center mt-2">
                    <span className={`text-[11px] ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>Check your inbox & spam folder</span>
                    <button
                      type="button"
                      disabled={resending}
                      onClick={handleResendCode}
                      className="text-[11px] text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${resending ? 'animate-spin' : ''}`} />
                      Resend Code
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {mode === 'signup' && (
                  <div>
                    <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Full Name</label>
                    <div className="relative">
                      <UserIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                      <input
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className={`${inputClass} pl-9`}
                        placeholder="Jane Doe"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Work Email</label>
                  <div className="relative">
                    <Mail className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={`${inputClass} pl-9`}
                      placeholder="name@company.com"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className={`text-xs font-medium ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Password</label>
                    {mode === 'signin' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot_password');
                          setError(null);
                          setInfoMessage(null);
                        }}
                        className="text-[11px] text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 font-medium transition-colors"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                    <input
                      type="password"
                      required
                      minLength={mode === 'signup' ? 8 : undefined}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pl-9`}
                      placeholder={mode === 'signup' ? 'Min 8 chars, numbers & symbols' : '••••••••'}
                    />
                  </div>
                </div>

                {mode === 'signup' && (
                  <div>
                    <label className={`text-xs font-medium block mb-1 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>Organization Name</label>
                    <div className="relative">
                      <Building2 className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} />
                      <input
                        type="text"
                        required
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        className={`${inputClass} pl-9`}
                        placeholder="Acme Inc."
                      />
                    </div>
                    <p className={`text-[10px] mt-1.5 flex items-center gap-1 ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>
                      <ShieldCheck className="w-3 h-3 text-cyan-500" />
                      Your sign-in is protected.
                    </p>
                  </div>
                )}
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 active:from-cyan-700 active:to-blue-700 text-white font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-lg shadow-cyan-600/20 disabled:opacity-50 mt-4"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {mode === 'signin'
                    ? 'Signing in...'
                    : mode === 'confirm'
                    ? 'Verifying Code...'
                    : mode === 'mfa'
                    ? 'Verifying MFA Code...'
                    : mode === 'forgot_password'
                    ? 'Sending Reset Code...'
                    : mode === 'reset_password'
                    ? 'Resetting Password...'
                    : 'Creating account...'}
                </>
              ) : (
                mode === 'signin'
                  ? 'Sign In'
                  : mode === 'confirm'
                  ? 'Verify Code & Sign In'
                  : mode === 'mfa'
                  ? 'Verify Code & Complete Sign In'
                  : mode === 'forgot_password'
                  ? 'Send Reset Code'
                  : mode === 'reset_password'
                  ? 'Reset Password & Sign In'
                  : 'Create Account'
              )}
            </button>
          </form>



          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className={`w-full text-center text-[11px] ${isLight ? 'text-slate-500 hover:text-slate-800' : 'text-slate-500 hover:text-slate-300'} transition-colors`}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
