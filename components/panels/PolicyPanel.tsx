'use client';
import React, { useMemo, useState } from 'react';
import { ClipboardList, Loader2, Plus, X, ShieldAlert, CheckCircle2, Info } from 'lucide-react';
import clsx from 'clsx';
import { useApp, useActiveProject } from '@/context/AppContext';
import { REGION_LABELS } from '@/types';
import { OrgPolicyRulesSchema, normalizeRules } from '@/lib/engines/policy/schema';
import { evaluateOrgPolicy } from '@/lib/engines/policy/evaluate';
import type { OrgPolicy, OrgPolicyRules } from '@/lib/engines/policy/types';
import type { Project } from '@/types';
import { saveOrgPolicy, useOrgPolicy } from '@/components/policy/orgPolicyStore';

/** A tag row as typed: the allowed values are one comma-separated string. */
interface TagRow { key: string; values: string }

interface Draft {
  approvedRegions: string[];
  allowedInstanceTypes: string[];
  tags: TagRow[];
  namingPattern: string;
}

const toDraft = (r: OrgPolicyRules): Draft => ({
  approvedRegions: r.approvedRegions,
  allowedInstanceTypes: r.allowedInstanceTypes,
  tags: r.requiredTags.map((t) => ({ key: t.key, values: (t.allowedValues ?? []).join(', ') })),
  namingPattern: r.namingPattern,
});

const toRules = (d: Draft): OrgPolicyRules => normalizeRules({
  approvedRegions: d.approvedRegions,
  allowedInstanceTypes: d.allowedInstanceTypes,
  requiredTags: d.tags
    .map((t) => ({ key: t.key.trim(), allowedValues: t.values.split(',').map((v) => v.trim()).filter(Boolean) }))
    .filter((t) => t.key !== '')
    .map((t) => (t.allowedValues.length > 0 ? t : { key: t.key })),
  namingPattern: d.namingPattern.trim(),
});

const MAX_SHOWN = 40;

function ChipInput({ label, hint, values, onChange, placeholder, suggestions, disabled, isLight, testId }: {
  label: string; hint: string; values: string[]; onChange: (v: string[]) => void; placeholder: string;
  suggestions?: string[]; disabled: boolean; isLight: boolean; testId: string;
}) {
  const [text, setText] = useState('');
  const listId = `${testId}-list`;
  const add = () => {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) onChange([...new Set([...values, ...parts])]);
    setText('');
  };
  return (
    <div data-testid={testId}>
      <label className={clsx('text-xs font-semibold block', isLight ? 'text-slate-800' : 'text-slate-200')}>{label}</label>
      <p className={clsx('text-[11px] mb-2', isLight ? 'text-slate-500' : 'text-slate-400')}>{hint}</p>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.length === 0 && <span className={clsx('text-[11px] italic', isLight ? 'text-slate-400' : 'text-slate-500')}>No restriction</span>}
        {values.map((v) => (
          <span key={v} className={clsx('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-mono', isLight ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-slate-800 border-slate-700 text-slate-200')}>
            {v}
            {!disabled && (
              <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="opacity-60 hover:opacity-100">
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <div className="flex gap-2">
          <input
            list={suggestions ? listId : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
            placeholder={placeholder}
            aria-label={`Add to ${label}`}
            className={clsx('flex-1 rounded-lg px-3 py-1.5 text-sm border focus:outline-none focus:ring-2 focus:ring-blue-500', isLight ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400' : 'bg-gray-950 border-gray-800 text-white placeholder-gray-600')}
          />
          {suggestions && <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
          <button type="button" onClick={add} disabled={!text.trim()} className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40">Add</button>
        </div>
      )}
    </div>
  );
}

export default function PolicyPanel() {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const project = useActiveProject();
  const { status, policy, canEdit, error: loadError } = useOrgPolicy(state.currentUser?.id);

  return (
    <div className={clsx('flex-1 overflow-y-auto px-4 sm:px-8 py-8 pb-36 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-slate-100')}>
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className={clsx('text-xl font-bold flex items-center gap-2', isLight ? 'text-slate-900' : 'text-white')}>
            <ClipboardList className={clsx('w-5 h-5', isLight ? 'text-blue-600' : 'text-blue-400')} />
            Organization policy
          </h1>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-600' : 'text-slate-400')}>
            The regions, instance sizes, tags and naming your organization&apos;s architectures should follow. Resources that break the policy are
            flagged with a warning, and options the policy does not allow are greyed out in the dropdowns — nothing is blocked.
          </p>
        </div>

        {status === 'loading' && <div className="flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading policy…</div>}
        {status === 'error' && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 text-rose-800 px-3 py-2 text-sm">{loadError}</div>}

        {/* Keyed by version so the editor starts from the saved policy each time one is loaded or saved. */}
        {status === 'ready' && policy && <PolicyEditor key={policy.version} policy={policy} canEdit={canEdit} isLight={isLight} project={project} />}
      </div>
    </div>
  );
}

function PolicyEditor({ policy, canEdit, isLight, project }: { policy: OrgPolicy; canEdit: boolean; isLight: boolean; project: Project | null }) {
  const saved = useMemo<OrgPolicyRules>(() => ({
    approvedRegions: policy.approvedRegions, allowedInstanceTypes: policy.allowedInstanceTypes, requiredTags: policy.requiredTags, namingPattern: policy.namingPattern,
  }), [policy]);

  const [draft, setDraft] = useState<Draft>(() => toDraft(saved));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const draftRules = useMemo(() => toRules(draft), [draft]);
  const validation = useMemo(() => OrgPolicyRulesSchema.safeParse(draftRules), [draftRules]);
  const dirty = JSON.stringify(draftRules) !== JSON.stringify(normalizeRules(saved));

  // What the current architecture would look like under the draft policy (the saved one when the draft is not valid yet).
  const previewRules = validation.success ? draftRules : saved;
  const violations = useMemo(
    () => evaluateOrgPolicy((project?.nodes ?? []).map((n) => ({ id: n.id, label: n.label, resourceType: n.resourceType, region: n.region, config: n.config })), previewRules),
    [project?.nodes, previewRules],
  );
  const resourceCount = new Set(violations.map((v) => v.resourceId)).size;

  const save = async () => {
    if (!validation.success) return;
    setSaving(true); setSaveError(null); setSavedNotice(false);
    const result = await saveOrgPolicy(draftRules);
    setSaving(false);
    if (result.ok) { setSavedNotice(true); setTimeout(() => setSavedNotice(false), 3000); } else setSaveError(result.error);
  };

  const card = clsx('border rounded-2xl p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-900 border-gray-800');
  const input = clsx('rounded-lg px-3 py-1.5 text-sm border focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60', isLight ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400' : 'bg-gray-950 border-gray-800 text-white placeholder-gray-600');
  const readOnly = !canEdit;

  return (
          <>
            {readOnly && (
              <div className={clsx('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', isLight ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-blue-950/40 border-blue-800/60 text-blue-200')}>
                <Info className="w-4 h-4 shrink-0 mt-0.5" /> Only an owner or admin of the organization can change the policy. You can see what it requires.
              </div>
            )}

            <div className={clsx(card, 'space-y-6')}>
              <ChipInput testId="policy-regions" label="Approved regions" hint="Resources may be placed only in these regions (AWS or Azure names)." values={draft.approvedRegions}
                onChange={(v) => setDraft({ ...draft, approvedRegions: v })} placeholder="e.g. ap-south-1" suggestions={Object.keys(REGION_LABELS)} disabled={readOnly} isLight={isLight} />

              <ChipInput testId="policy-instance-types" label="Allowed instance types" hint="Patterns where * matches anything. Each service has its own prefix: t3.* (EC2, Auto Scaling), db.t3.* (RDS), cache.t3.* (ElastiCache), Standard_B* (Azure VMs)." values={draft.allowedInstanceTypes}
                onChange={(v) => setDraft({ ...draft, allowedInstanceTypes: v })} placeholder="e.g. t3.*" disabled={readOnly} isLight={isLight} />

              <div data-testid="policy-tags">
                <label className={clsx('text-xs font-semibold block', isLight ? 'text-slate-800' : 'text-slate-200')}>Required tags</label>
                <p className={clsx('text-[11px] mb-2', isLight ? 'text-slate-500' : 'text-slate-400')}>Every taggable resource must carry these tags. Leave the values empty to accept any value.</p>
                <div className="space-y-2">
                  {draft.tags.length === 0 && <span className={clsx('text-[11px] italic', isLight ? 'text-slate-400' : 'text-slate-500')}>No restriction</span>}
                  {draft.tags.map((t, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input aria-label="Tag key" disabled={readOnly} value={t.key} placeholder="CostCenter" className={clsx(input, 'w-40')}
                        onChange={(e) => setDraft({ ...draft, tags: draft.tags.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                      <input aria-label="Allowed tag values" disabled={readOnly} value={t.values} placeholder="Allowed values, comma-separated (optional)" className={clsx(input, 'flex-1')}
                        onChange={(e) => setDraft({ ...draft, tags: draft.tags.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)) })} />
                      {!readOnly && (
                        <button type="button" aria-label="Remove tag" onClick={() => setDraft({ ...draft, tags: draft.tags.filter((_, j) => j !== i) })} className="text-slate-400 hover:text-rose-500"><X className="w-4 h-4" /></button>
                      )}
                    </div>
                  ))}
                </div>
                {!readOnly && (
                  <button type="button" onClick={() => setDraft({ ...draft, tags: [...draft.tags, { key: '', values: '' }] })} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-500">
                    <Plus className="w-3.5 h-3.5" /> Add a required tag
                  </button>
                )}
              </div>

              <div data-testid="policy-naming">
                <label htmlFor="policy-naming-input" className={clsx('text-xs font-semibold block', isLight ? 'text-slate-800' : 'text-slate-200')}>Naming pattern</label>
                <p className={clsx('text-[11px] mb-2', isLight ? 'text-slate-500' : 'text-slate-400')}>A regular expression every resource name must match, e.g. <code>^(prod|stg|dev)-[a-z0-9-]+$</code>. Leave empty for no standard.</p>
                <input id="policy-naming-input" disabled={readOnly} value={draft.namingPattern} onChange={(e) => setDraft({ ...draft, namingPattern: e.target.value })} placeholder="^(prod|stg|dev)-[a-z0-9-]+$" className={clsx(input, 'w-full font-mono')} />
              </div>

              {!validation.success && (
                <p role="alert" className="text-xs text-rose-600">{validation.error.issues[0]?.message ?? 'The policy is not valid'}</p>
              )}

              {!readOnly && (
                <div className="flex items-center gap-3 pt-1">
                  <button type="button" onClick={save} disabled={!dirty || !validation.success || saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg disabled:opacity-50 inline-flex items-center gap-2 shadow-sm">
                    {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save policy
                  </button>
                  {dirty && <button type="button" onClick={() => setDraft(toDraft(saved))} className="text-sm text-slate-500 hover:text-slate-700">Discard changes</button>}
                  {savedNotice && <span className="text-sm text-emerald-600 inline-flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Saved (version {policy?.version})</span>}
                  {saveError && <span role="alert" className="text-sm text-rose-600">{saveError}</span>}
                </div>
              )}
              {policy && policy.version > 0 && (
                <p className={clsx('text-[11px]', isLight ? 'text-slate-400' : 'text-slate-500')}>Version {policy.version} · last changed by {policy.updatedBy}{policy.updatedAt ? ` on ${new Date(policy.updatedAt).toLocaleDateString()}` : ''}</p>
              )}
            </div>

            <div className={card} data-testid="policy-impact">
              <h2 className={clsx('text-sm font-semibold flex items-center gap-2', isLight ? 'text-slate-900' : 'text-white')}>
                <ShieldAlert className="w-4 h-4 text-amber-500" />
                {dirty ? 'What your unsaved changes would flag' : 'Current architecture'}
              </h2>
              {!project || project.nodes.length === 0 ? (
                <p className={clsx('text-sm mt-2', isLight ? 'text-slate-500' : 'text-slate-400')}>Open a project with resources to see how it measures up.</p>
              ) : violations.length === 0 ? (
                <p className="text-sm mt-2 text-emerald-600 inline-flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> {project.name} meets the policy.</p>
              ) : (
                <>
                  <p className={clsx('text-sm mt-1', isLight ? 'text-slate-600' : 'text-slate-400')}>
                    {violations.length} {violations.length === 1 ? 'warning' : 'warnings'} on {resourceCount} {resourceCount === 1 ? 'resource' : 'resources'} in {project.name}.
                  </p>
                  <ul className="mt-3 space-y-2">
                    {violations.slice(0, MAX_SHOWN).map((v, i) => (
                      <li key={`${v.resourceId}-${v.ruleId}-${i}`} className={clsx('text-xs rounded-lg border px-3 py-2', isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-950/30 border-amber-500/30 text-amber-200')}>
                        {v.message}
                        <span className="block opacity-75">Policy: {v.expected}</span>
                      </li>
                    ))}
                  </ul>
                  {violations.length > MAX_SHOWN && <p className="text-xs mt-2 text-slate-500">…and {violations.length - MAX_SHOWN} more.</p>}
                </>
              )}
            </div>
          </>
  );
}
