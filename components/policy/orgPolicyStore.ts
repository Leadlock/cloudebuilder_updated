'use client';
/**
 * The organization policy on the client: loaded once per signed-in user and shared by every component that shows policy warnings, so
 * saving in the Policy panel updates the properties panel at once without a provider or a second request.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { OrgPolicy, OrgPolicyRules } from '@/lib/engines/policy/types';

export interface OrgPolicyState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  policy: OrgPolicy | null;
  canEdit: boolean;
  error: string | null;
}

const INITIAL: OrgPolicyState = { status: 'idle', policy: null, canEdit: false, error: null };

let state: OrgPolicyState = INITIAL;
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function set(next: OrgPolicyState) {
  state = next;
  listeners.forEach((l) => l());
}

async function request(init?: RequestInit): Promise<{ policy: OrgPolicy; canEdit: boolean }> {
  const res = await fetch('/api/org-policy', { credentials: 'include', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? 'Could not reach the policy service');
  return body.data;
}

export async function loadOrgPolicy(userId: string): Promise<void> {
  loadedFor = userId;
  set({ ...state, status: 'loading', error: null });
  try {
    const { policy, canEdit } = await request();
    if (loadedFor === userId) set({ status: 'ready', policy, canEdit, error: null });
  } catch (err) {
    if (loadedFor === userId) set({ ...state, status: 'error', error: err instanceof Error ? err.message : 'Could not load the policy' });
  }
}

export async function saveOrgPolicy(rules: OrgPolicyRules): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { policy, canEdit } = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rules) });
    set({ status: 'ready', policy, canEdit, error: null });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save the policy' };
  }
}

/** Forget everything — call when the user signs out so the next user never sees this organization's policy. */
export function clearOrgPolicy(): void {
  loadedFor = null;
  set(INITIAL);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The shared policy state; loads it the first time a signed-in user is seen, and again when the user changes. */
export function useOrgPolicy(userId: string | undefined): OrgPolicyState {
  const current = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  useEffect(() => {
    if (!userId) { if (loadedFor) clearOrgPolicy(); return; }
    if (loadedFor !== userId) void loadOrgPolicy(userId);
  }, [userId]);
  return current;
}
