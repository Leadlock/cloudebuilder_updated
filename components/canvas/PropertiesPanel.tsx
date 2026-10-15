'use client';
import { useState, useEffect } from 'react';
import { CanvasNode, ConfigField } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { X, Settings, Network, Info, CheckCircle2, AlertTriangle, Layers, ShieldCheck, ShieldAlert, ExternalLink, Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import { useApp, useActiveProject } from '@/context/AppContext';
import type { WaFinding } from '@/lib/engines/wellArchitected/types';
import PolicyWarnings from '@/components/policy/PolicyWarnings';
import ContainerServiceCard from '@/components/canvas/ContainerServiceCard';
import { CONTAINER_NODE_TYPES } from '@/lib/engines/containers/nodeConfig';
import { useOrgPolicy } from '@/components/policy/orgPolicyStore';
import { isInstanceSizeAllowed } from '@/lib/engines/policy/allowed';
import type { OrgPolicyRules } from '@/lib/engines/policy/types';

interface PropertiesPanelProps {
  node: CanvasNode | null;
  onClose: () => void;
  onUpdate: (nodeId: string, config: Record<string, unknown>, label: string) => void;
}

/**
 * Canonical section ordering for grouped config UI. A field's `section`
 * (see ConfigField in types/index.ts) should be one of these; sections not
 * listed here render after these, in first-seen order. Fields with no
 * `section` fall into 'General'.
 */
const CONFIG_SECTION_ORDER = [
  'General',
  'Networking',
  'Compute / Capacity',
  'Storage',
  'Availability & Scaling',
  'Security',
  'Identity & Access',
  'Backup & Recovery',
  'Monitoring',
  'Advanced',
  'Tags',
];

function groupFieldsBySection(fields: ConfigField[]): { section: string; fields: ConfigField[] }[] {
  const order = [...CONFIG_SECTION_ORDER];
  const bySection = new Map<string, ConfigField[]>();
  for (const field of fields) {
    const section = field.section || 'General';
    if (!order.includes(section)) order.push(section);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push(field);
  }
  return order
    .filter((section) => bySection.has(section))
    .map((section) => ({ section, fields: bySection.get(section)! }));
}

function ConfigFieldInput({
  field,
  config,
  onChange,
  isLight = false,
  resourceType = '',
  policy = null,
}: {
  field: ConfigField;
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  isLight?: boolean;
  /** With `policy`, options the organization policy does not allow are greyed out (never the value already chosen). */
  resourceType?: string;
  policy?: OrgPolicyRules | null;
}) {
  const value = config[field.key] ?? field.defaultValue;

  if (field.type === 'boolean') {
    return (
      <label className={clsx(
        'flex items-center justify-between p-2 rounded-lg border cursor-pointer transition-colors',
        isLight
          ? 'bg-slate-100/80 border-slate-300 hover:border-slate-400'
          : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
      )}>
        <span className={clsx('text-xs font-medium', isLight ? 'text-slate-700' : 'text-slate-300')}>
          {value ? 'Enabled' : 'Disabled'}
        </span>
        <div className="relative">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(field.key, e.target.checked)}
            className="sr-only"
          />
          <div className={clsx('w-9 h-5 rounded-full transition-colors', value ? (isLight ? 'bg-blue-600' : 'bg-cyan-600') : (isLight ? 'bg-slate-300' : 'bg-slate-700'))} />
          <div
            className={clsx(
              'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
              value ? 'translate-x-4' : 'translate-x-0.5'
            )}
          />
        </div>
      </label>
    );
  }

  if (field.type === 'select') {
    const outsidePolicy = (optionValue: string) => optionValue !== String(value) && !isInstanceSizeAllowed(policy, resourceType, field.key, optionValue);
    const anyOutsidePolicy = Boolean(field.options?.some((opt) => outsidePolicy(opt.value)));
    return (
      <>
      <select
        value={String(value)}
        onChange={(e) => onChange(field.key, e.target.value)}
        className={clsx(
          'w-full border rounded-lg px-3 py-2 text-xs focus:outline-none transition-all',
          isLight
            ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
            : 'bg-slate-950 border-slate-700/80 text-white focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500'
        )}
      >
        {field.options?.map((opt) => {
          const blocked = outsidePolicy(opt.value);
          return (
            <option key={opt.value} value={opt.value} disabled={blocked} className={blocked ? 'text-slate-400' : undefined}>
              {opt.label}{blocked ? ' — outside org policy' : ''}
            </option>
          );
        })}
      </select>
      {anyOutsidePolicy && (
        <p className={clsx('mt-1 text-[10px]', isLight ? 'text-slate-500' : 'text-slate-400')}>Greyed options are outside your organization&apos;s policy.</p>
      )}
      </>
    );
  }

  if (field.type === 'multiselect') {
    const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
    return (
      <div className="flex flex-wrap gap-1.5">
        {field.options?.map((opt) => {
          const isSelected = selected.has(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                const next = new Set(selected);
                if (isSelected) next.delete(opt.value); else next.add(opt.value);
                onChange(field.key, [...next]);
              }}
              className={clsx(
                'px-2 py-1 rounded-md text-[11px] font-medium border transition-colors',
                isSelected
                  ? (isLight ? 'bg-blue-100 border-blue-400 text-blue-700 font-semibold' : 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300 font-medium')
                  : (isLight ? 'bg-slate-100 border-slate-300 text-slate-600 hover:border-slate-400' : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700')
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (field.type === 'tags') {
    const tags = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag, i) => (
            <span
              key={`${tag}-${i}`}
              className={clsx(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium',
                isLight ? 'bg-slate-200 border-slate-300 text-slate-800' : 'bg-slate-800 border-slate-700 text-slate-200'
              )}
            >
              {tag}
              <button type="button" onClick={() => onChange(field.key, tags.filter((_, idx) => idx !== i))} className={isLight ? 'text-slate-500 hover:text-rose-600' : 'text-slate-500 hover:text-rose-400'}>
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
        <input
          type="text"
          placeholder={field.placeholder || 'Type and press Enter'}
          onKeyDown={(e) => {
            const target = e.target as HTMLInputElement;
            if ((e.key === 'Enter' || e.key === ',') && target.value.trim()) {
              e.preventDefault();
              const next = target.value.trim();
              if (!tags.includes(next)) onChange(field.key, [...tags, next]);
              target.value = '';
            }
          }}
          className={clsx(
            'w-full border rounded-lg px-3 py-2 text-xs focus:outline-none transition-all',
            isLight
              ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-400'
              : 'bg-slate-950 border-slate-700/80 text-white focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 placeholder-slate-600'
          )}
        />
      </div>
    );
  }

  if (field.type === 'keyvalue') {
    const map = (value && typeof value === 'object' && !Array.isArray(value)) ? (value as Record<string, string>) : {};
    const rows = Object.entries(map);
    const setRows = (next: [string, string][]) => onChange(field.key, Object.fromEntries(next));
    return (
      <div className="space-y-1.5">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="text"
              value={k}
              placeholder="key"
              onChange={(e) => {
                const next = [...rows];
                next[i] = [e.target.value, v];
                setRows(next);
              }}
              className={clsx(
                'w-1/2 border rounded-lg px-2 py-1.5 text-xs focus:outline-none font-mono',
                isLight
                  ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-blue-500'
                  : 'bg-slate-950 border-slate-700/80 text-white focus:border-cyan-500'
              )}
            />
            <input
              type="text"
              value={v}
              placeholder="value"
              onChange={(e) => {
                const next = [...rows];
                next[i] = [k, e.target.value];
                setRows(next);
              }}
              className={clsx(
                'w-1/2 border rounded-lg px-2 py-1.5 text-xs focus:outline-none font-mono',
                isLight
                  ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-blue-500'
                  : 'bg-slate-950 border-slate-700/80 text-white focus:border-cyan-500'
              )}
            />
            <button type="button" onClick={() => setRows(rows.filter((_, idx) => idx !== i))} className={isLight ? 'text-slate-400 hover:text-rose-600 shrink-0' : 'text-slate-500 hover:text-rose-400 shrink-0'}>
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setRows([...rows, ['', '']])}
          className={clsx('text-[11px] font-semibold transition-colors', isLight ? 'text-blue-600 hover:text-blue-700' : 'text-cyan-400 hover:text-cyan-300')}
        >
          + Add entry
        </button>
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <input
        type="number"
        value={Number(value)}
        min={field.min}
        max={field.max}
        onChange={(e) => {
          const raw = Number(e.target.value);
          const clamped = field.min !== undefined && raw < field.min ? field.min
            : field.max !== undefined && raw > field.max ? field.max
            : raw;
          onChange(field.key, clamped);
        }}
        className={clsx(
          'w-full border rounded-lg px-3 py-2 text-xs focus:outline-none transition-all font-mono',
          isLight
            ? 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
            : 'bg-slate-950 border-slate-700/80 text-white focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500'
        )}
      />
    );
  }

  // 'text' and 'cidr' both render as a plain text input; 'cidr' gets a monospace hint via placeholder.
  return (
    <input
      type="text"
      value={String(value)}
      onChange={(e) => onChange(field.key, e.target.value)}
      placeholder={field.placeholder}
      className={clsx(
        'w-full border rounded-lg px-3 py-2 text-xs focus:outline-none transition-all',
        isLight
          ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
          : 'bg-slate-950 border-slate-700/80 text-white placeholder-slate-600 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500',
        field.type === 'cidr' && 'font-mono'
      )}
    />
  );
}

export default function PropertiesPanel({ node, onClose, onUpdate }: PropertiesPanelProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const activeProject = useActiveProject();
  const { policy } = useOrgPolicy(state.currentUser?.id);
  const [activeTab, setActiveTab] = useState<'config' | 'placement' | 'info' | 'waf'>('config');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [wafFindings, setWafFindings] = useState<WaFinding[]>([]);
  const [loadingWaf, setLoadingWaf] = useState(false);

  useEffect(() => {
    if (!node || !activeProject) return;
    let isCancelled = false;
    Promise.resolve().then(async () => {
      if (isCancelled) return;
      setLoadingWaf(true);
      try {
        const findings = await apiWellArchitectedService.getResourceFindings(node.id, activeProject.id);
        if (!isCancelled) {
          setWafFindings(findings || []);
        }
      } catch {
        if (!isCancelled) {
          setWafFindings([]);
        }
      } finally {
        if (!isCancelled) {
          setLoadingWaf(false);
        }
      }
    });
    return () => { isCancelled = true; };
  }, [node?.id, activeProject?.id]);

  // Declared before the early returns: a hook after them runs only when a node is selected, so selecting one changed the hook count and React threw.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!node) return null;
  const def = getResourceDefinition(node.resourceType);
  if (!def) return null;

  function handleChange(key: string, value: unknown) {
    if (!node) return;
    const newConfig = { ...node.config, [key]: value };
    const newLabel = key === 'name' ? (value as string) || node.label : node.label;
    onUpdate(node.id, newConfig, newLabel);
  }

  const isContainer = def.isContainer === true;
  const provider = node.provider ?? def.provider;
  const isVpc = node.resourceType === 'aws_vpc' || node.resourceType === 'azure_vnet';
  const isSubnet = node.resourceType === 'aws_subnet' || node.resourceType === 'azure_subnet';
  const isImported = node.importState === 'imported' || node.config?.imported === true || node.config?.importState === 'imported';
  const cloudArn = (node.config?.arn as string) || (node.config?.providerResourceId as string) || '';
  const cloudRegion = (node.config?.region as string) || node.region || '';
  const cloudSource = (node.config?.source as string) || (provider === 'azure' ? 'azure-arm' : 'aws-api');

  const rawStatus = (node.config?.status as string) || (node.config?.cloudStatus as string) || (node.config?.state as string) || '';
  const normalizedStatus = rawStatus ? String(rawStatus).toLowerCase().trim() : '';
  const cloudResourceId = (node.config?.resourceId as string) || (node.config?.providerResourceId as string) || (node.id.startsWith('node-') ? '' : node.id);

  function copyToClipboard(text: string, key: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
      }).catch(() => {});
    }
  }

  const isDeleted = normalizedStatus === 'deleted' || normalizedStatus === 'terminated';
  const isDeleting = normalizedStatus === 'deleting' || normalizedStatus === 'terminating';
  const isStopped = normalizedStatus === 'stopped' || normalizedStatus === 'inactive' || normalizedStatus === 'paused';
  const isPending = normalizedStatus === 'pending' || normalizedStatus === 'creating' || normalizedStatus === 'provisioning';
  const isFailed = normalizedStatus === 'failed' || normalizedStatus === 'error';

  return (
    <div className={clsx(
      'w-full sm:w-80 sm:relative fixed inset-y-0 right-0 z-40 sm:z-20 border-l flex flex-col shrink-0 select-none shadow-2xl animate-in slide-in-from-right duration-150',
      isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-[#18181a] border-white/8 text-white'
    )}>
      {/* Header */}
      <div className={clsx(
        'flex items-center gap-3 px-4 py-3.5 border-b',
        isLight ? 'border-slate-200 bg-slate-50/80' : 'border-white/8 bg-[#141416]'
      )}>
        <div className={clsx('p-1.5 rounded-lg border shrink-0', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-[#1c1c1e] border-white/10 shadow-xs')}>
          <CloudServiceIcon
            provider={provider}
            resourceType={node.resourceType}
            size={24}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className={clsx('text-sm font-bold truncate leading-tight', isLight ? 'text-slate-900' : 'text-white')}>{node.label}</p>
            {isContainer && (
              <span className={clsx('text-[9px] px-1 py-0.2 rounded font-medium', isLight ? 'bg-purple-100 text-purple-700 border border-purple-200' : 'bg-purple-500/20 text-purple-300')}>
                Container
              </span>
            )}
            {isImported && (
              <span className={clsx('text-[9px] px-1 py-0.2 rounded font-medium', isLight ? 'bg-cyan-100 text-cyan-800 border border-cyan-300' : 'bg-[#0078d4]/20 text-[#50e6ff] border-[#0078d4]/40')}>
                Imported
              </span>
            )}
            {normalizedStatus && (
              <span
                className={clsx(
                  'text-[8px] font-bold px-1.5 py-0.2 rounded uppercase tracking-wider',
                  isDeleted ? (isLight ? 'bg-slate-200 text-slate-700 border border-slate-300' : 'bg-slate-800 text-slate-300 border border-slate-600') :
                  isDeleting ? (isLight ? 'bg-rose-100 text-rose-800 border border-rose-300 animate-pulse' : 'bg-rose-950 text-rose-300 border border-rose-500/40 animate-pulse') :
                  isStopped ? (isLight ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-amber-950 text-amber-300 border border-amber-500/40') :
                  isPending ? (isLight ? 'bg-sky-100 text-sky-800 border border-sky-300 animate-pulse' : 'bg-sky-950 text-sky-300 border border-sky-500/40 animate-pulse') :
                  isFailed ? (isLight ? 'bg-rose-100 text-rose-800 border border-rose-300' : 'bg-rose-950 text-rose-300 border border-rose-500/40') :
                  (isLight ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-emerald-950 text-emerald-300 border border-emerald-500/40')
                )}
              >
                {normalizedStatus}
              </span>
            )}
          </div>
          <p className={clsx('text-[11px] truncate mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
            {def.service || def.label}
          </p>
        </div>

        <button
          onClick={onClose}
          className={clsx(
            'p-1 rounded-lg transition-colors shrink-0',
            isLight ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100' : 'text-slate-500 hover:text-white hover:bg-white/10'
          )}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <PolicyWarnings node={node} />

      {/* Tabs */}
      <div className={clsx(
        'flex items-center px-4 border-b text-xs',
        isLight ? 'border-slate-200 bg-slate-50/50' : 'border-white/8 bg-[#141416]/50'
      )}>
        <button
          onClick={() => setActiveTab('config')}
          className={clsx(
            'py-2.5 px-3 border-b-2 font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'config'
              ? (isLight ? 'border-[#0078d4] text-[#0078d4] font-semibold' : 'border-[#50e6ff] text-[#50e6ff] font-semibold')
              : (isLight ? 'border-transparent text-slate-500 hover:text-slate-800' : 'border-transparent text-slate-400 hover:text-slate-200')
          )}
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Config</span>
        </button>

        <button
          onClick={() => setActiveTab('placement')}
          className={clsx(
            'py-2.5 px-3 border-b-2 font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'placement'
              ? (isLight ? 'border-blue-600 text-blue-600 font-semibold' : 'border-cyan-400 text-cyan-400 font-semibold')
              : (isLight ? 'border-transparent text-slate-500 hover:text-slate-800' : 'border-transparent text-slate-400 hover:text-slate-200')
          )}
        >
          <Network className="w-3.5 h-3.5" />
          <span>Topology</span>
        </button>

        <button
          onClick={() => setActiveTab('info')}
          className={clsx(
            'py-2.5 px-3 border-b-2 font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'info'
              ? (isLight ? 'border-blue-600 text-blue-600 font-semibold' : 'border-cyan-400 text-cyan-400 font-semibold')
              : (isLight ? 'border-transparent text-slate-500 hover:text-slate-800' : 'border-transparent text-slate-400 hover:text-slate-200')
          )}
        >
          <Info className="w-3.5 h-3.5" />
          <span>Summary</span>
        </button>

        <button
          onClick={() => setActiveTab('waf')}
          className={clsx(
            'py-2.5 px-3 border-b-2 font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'waf'
              ? (isLight ? 'border-blue-600 text-blue-600 font-semibold' : 'border-cyan-400 text-cyan-400 font-semibold')
              : (isLight ? 'border-transparent text-slate-500 hover:text-slate-800' : 'border-transparent text-slate-400 hover:text-slate-200')
          )}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>WAF</span>
          {wafFindings.length > 0 && (
            <span
              className={clsx(
                'px-1.5 py-0.2 rounded-full text-[9px] font-bold leading-none',
                wafFindings.some((f) => f.severity === 'critical')
                  ? 'bg-rose-500 text-white'
                  : 'bg-amber-500 text-slate-950'
              )}
            >
              {wafFindings.length}
            </span>
          )}
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {CONTAINER_NODE_TYPES.includes(node.resourceType) && <ContainerServiceCard nodeId={node.id} resourceType={node.resourceType} config={node.config} isLight={isLight} />}
        {isImported && (
          <div className={clsx(
            'p-3 rounded-xl border space-y-2.5 shadow-sm',
            isLight ? 'bg-cyan-50/50 border-cyan-200' : 'bg-slate-950/80 border-cyan-500/40 shadow-lg'
          )}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
                <span className={clsx('text-[11px] font-bold uppercase tracking-wider', isLight ? 'text-cyan-800' : 'text-cyan-300')}>
                  Live Cloud Resource
                </span>
              </div>
              <span
                className={clsx(
                  'text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full flex items-center gap-1',
                  isDeleted ? (isLight ? 'bg-slate-200 text-slate-700 border border-slate-300' : 'bg-slate-800 text-slate-300 border border-slate-600') :
                  isDeleting ? (isLight ? 'bg-rose-100 text-rose-800 border border-rose-300 animate-pulse' : 'bg-rose-950 text-rose-300 border border-rose-500/40 animate-pulse') :
                  isStopped ? (isLight ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-amber-950 text-amber-300 border border-amber-500/40') :
                  isPending ? (isLight ? 'bg-sky-100 text-sky-800 border border-sky-300 animate-pulse' : 'bg-sky-950 text-sky-300 border border-sky-500/40 animate-pulse') :
                  isFailed ? (isLight ? 'bg-rose-100 text-rose-800 border border-rose-300' : 'bg-rose-950 text-rose-300 border border-rose-500/40') :
                  (isLight ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/40')
                )}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full', isDeleted ? 'bg-slate-400' : isDeleting || isFailed ? 'bg-rose-400' : isStopped ? 'bg-amber-400' : isPending ? 'bg-sky-400' : 'bg-emerald-400')} />
                {normalizedStatus || 'Available'}
              </span>
            </div>

            {Boolean(cloudResourceId) && (
              <div className={clsx('flex items-center justify-between text-xs p-2 rounded-lg border', isLight ? 'bg-white border-slate-200' : 'bg-slate-900/90 border-slate-800')}>
                <div className="min-w-0 flex-1 pr-2">
                  <span className={clsx('text-[10px] block', isLight ? 'text-slate-500' : 'text-slate-500')}>Resource ID</span>
                  <span className={clsx('font-mono text-xs truncate block font-medium', isLight ? 'text-slate-900' : 'text-white')}>
                    {cloudResourceId}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(cloudResourceId, 'id')}
                  className={clsx('p-1 rounded transition-colors shrink-0', isLight ? 'text-slate-400 hover:text-blue-600 hover:bg-slate-100' : 'text-slate-400 hover:text-cyan-300 hover:bg-slate-800')}
                  title="Copy Resource ID"
                >
                  {copiedKey === 'id' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}

            {Boolean(cloudArn) && cloudArn !== cloudResourceId && (
              <div className={clsx('flex items-start justify-between text-xs p-2 rounded-lg border', isLight ? 'bg-white border-slate-200' : 'bg-slate-900/90 border-slate-800')}>
                <div className="min-w-0 flex-1 pr-2">
                  <span className={clsx('text-[10px] block', isLight ? 'text-slate-500' : 'text-slate-500')}>Cloud ARN</span>
                  <span className={clsx('font-mono text-[10px] break-all leading-tight block', isLight ? 'text-blue-700' : 'text-cyan-300')}>
                    {cloudArn}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(cloudArn, 'arn')}
                  className={clsx('p-1 rounded transition-colors shrink-0 mt-1', isLight ? 'text-slate-400 hover:text-blue-600 hover:bg-slate-100' : 'text-slate-400 hover:text-cyan-300 hover:bg-slate-800')}
                  title="Copy ARN"
                >
                  {copiedKey === 'arn' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}

            <div className={clsx('flex items-center justify-between text-[11px] pt-0.5', isLight ? 'text-slate-600' : 'text-slate-400')}>
              <span>Region: <strong className={clsx('font-mono', isLight ? 'text-slate-800' : 'text-slate-300')}>{cloudRegion || 'us-east-1'}</strong></span>
              <span>Provider: <strong className={isLight ? 'text-amber-600 font-semibold' : 'text-amber-400'}>{provider.toUpperCase()}</strong></span>
            </div>
          </div>
        )}

        {activeTab === 'config' && (() => {
          const visibleFields = def.configSchema.filter((f) => !f.visibleWhen || f.visibleWhen(node.config));
          const hiddenAdvancedCount = visibleFields.filter((f) => f.advanced && !showAdvanced).length;
          const sections = groupFieldsBySection(visibleFields);
          return (
            <div className="space-y-5">
              {sections.map(({ section, fields }) => {
                const shown = fields.filter((f) => showAdvanced || !f.advanced);
                if (shown.length === 0) return null;
                return (
                  <div key={section} className="space-y-3">
                    <h3 className={clsx(
                      'text-[10px] font-bold uppercase tracking-wider border-b pb-1.5',
                      isLight ? 'text-slate-500 border-slate-200' : 'text-slate-500 border-slate-800'
                    )}>
                      {section}
                    </h3>
                    <div className="space-y-3.5">
                      {shown.map((field) => (
                        <div key={field.key} className="space-y-1.5">
                          <label className={clsx('text-xs font-medium flex items-center justify-between', isLight ? 'text-slate-700' : 'text-slate-300')}>
                            <span className="flex items-center gap-1">
                              {field.label}
                              {field.required && <span className="text-rose-500">*</span>}
                              {field.description && (
                                <span title={field.description} className={clsx('cursor-help', isLight ? 'text-slate-400 hover:text-slate-600' : 'text-slate-600 hover:text-slate-400')}>
                                  <Info className="w-3 h-3" />
                                </span>
                              )}
                            </span>
                            {field.placeholder && field.type !== 'tags' && (
                              <span className={clsx('text-[10px] font-mono font-normal', isLight ? 'text-slate-400' : 'text-slate-500')}>
                                {field.placeholder}
                              </span>
                            )}
                          </label>
                          <ConfigFieldInput field={field} config={node.config} onChange={handleChange} isLight={isLight} resourceType={node.resourceType} policy={policy} />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}

              {hiddenAdvancedCount > 0 && !showAdvanced && (
                <button
                  type="button"
                  onClick={() => setShowAdvanced(true)}
                  className={clsx(
                    'w-full text-center text-[11px] font-semibold py-2 rounded-lg border border-dashed transition-colors',
                    isLight ? 'border-slate-300 text-blue-600 hover:border-blue-400 bg-blue-50/40' : 'border-slate-700 text-cyan-400 hover:text-cyan-300 hover:border-cyan-500/50'
                  )}
                >
                  Show {hiddenAdvancedCount} advanced setting{hiddenAdvancedCount === 1 ? '' : 's'}
                </button>
              )}
              {showAdvanced && def.configSchema.some((f) => f.advanced) && (
                <button
                  type="button"
                  onClick={() => setShowAdvanced(false)}
                  className={clsx(
                    'w-full text-center text-[11px] font-semibold py-2 rounded-lg border border-dashed transition-colors',
                    isLight ? 'border-slate-200 text-slate-500 hover:text-slate-700 bg-slate-50' : 'border-slate-800 text-slate-500 hover:text-slate-300'
                  )}
                >
                  Hide advanced settings
                </button>
              )}
            </div>
          );
        })()}

        {activeTab === 'placement' && (
          <div className="space-y-3">
            <div className={clsx('p-3 rounded-xl border space-y-2', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
              <span className={clsx('text-[11px] font-semibold uppercase tracking-wider block', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Container Hierarchy
              </span>
              <div className={clsx('text-xs flex items-center justify-between', isLight ? 'text-slate-700' : 'text-slate-300')}>
                <span className={isLight ? 'text-slate-500' : 'text-slate-500'}>Parent Container</span>
                <span className={clsx('font-mono font-medium', isLight ? 'text-blue-600' : 'text-cyan-400')}>
                  {node.groupId ? node.groupId.substring(0, 16) : 'Standalone (No Parent)'}
                </span>
              </div>
              <div className={clsx('text-xs flex items-center justify-between', isLight ? 'text-slate-700' : 'text-slate-300')}>
                <span className={isLight ? 'text-slate-500' : 'text-slate-500'}>Container Type</span>
                <span className={clsx('font-medium', isLight ? 'text-slate-800' : 'text-slate-300')}>
                  {isVpc ? 'VPC / VNet Boundary' : isSubnet ? 'Subnet Boundary' : 'Leaf Resource'}
                </span>
              </div>
              {Boolean(node.config.subnetName) && (
                <div className={clsx('text-xs flex items-center justify-between', isLight ? 'text-slate-700' : 'text-slate-300')}>
                  <span className={isLight ? 'text-slate-500' : 'text-slate-500'}>Subnet Binding</span>
                  <span className={clsx('font-semibold', isLight ? 'text-emerald-700' : 'text-emerald-400')}>{String(node.config.subnetName)}</span>
                </div>
              )}
            </div>

            <div className={clsx('p-3 rounded-xl border space-y-2', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
              <span className={clsx('text-[11px] font-semibold uppercase tracking-wider block', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Position & Dimensions
              </span>
              <div className={clsx('grid grid-cols-2 gap-2 text-xs font-mono', isLight ? 'text-slate-800' : 'text-slate-300')}>
                <div className={clsx('p-2 rounded border', isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800')}>
                  <span className={clsx('block text-[10px]', isLight ? 'text-slate-500' : 'text-slate-500')}>X Position</span>
                  {Math.round(node.position.x)} px
                </div>
                <div className={clsx('p-2 rounded border', isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800')}>
                  <span className={clsx('block text-[10px]', isLight ? 'text-slate-500' : 'text-slate-500')}>Y Position</span>
                  {Math.round(node.position.y)} px
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'info' && (
          <div className="space-y-3">
            <div className={clsx('p-3 rounded-xl border space-y-2', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
              <span className={clsx('text-[11px] font-bold uppercase tracking-wider block', isLight ? 'text-slate-700' : 'text-slate-400')}>
                Resource Specs
              </span>
              <div className={clsx('text-xs flex justify-between', isLight ? 'text-slate-800' : 'text-slate-300')}>
                <span className={isLight ? 'text-slate-600' : 'text-slate-400'}>Resource Type</span>
                <span className={clsx('font-mono font-medium', isLight ? 'text-slate-900' : 'text-slate-300')}>{node.resourceType}</span>
              </div>
              <div className={clsx('text-xs flex justify-between', isLight ? 'text-slate-800' : 'text-slate-300')}>
                <span className={isLight ? 'text-slate-600' : 'text-slate-400'}>Provider</span>
                <span className={clsx('font-bold', isLight ? 'text-amber-700' : 'text-amber-400')}>{provider.toUpperCase()}</span>
              </div>
              <div className={clsx('text-xs flex justify-between', isLight ? 'text-slate-800' : 'text-slate-300')}>
                <span className={isLight ? 'text-slate-600' : 'text-slate-400'}>Est. Base Cost</span>
                <span className={clsx('font-semibold', isLight ? 'text-emerald-700' : 'text-emerald-400')}>
                  {def.monthlyBaseCost > 0 ? `$${def.monthlyBaseCost.toFixed(2)} / mo` : 'Free Tier'}
                </span>
              </div>
            </div>

            {isImported && (
              <div className={clsx('p-3 rounded-xl border space-y-2', isLight ? 'bg-cyan-50/70 border-cyan-200' : 'bg-slate-950/60 border-cyan-500/30')}>
                <span className={clsx('text-[11px] font-bold uppercase tracking-wider block', isLight ? 'text-cyan-900' : 'text-cyan-400')}>
                  Cloud Identity (Live)
                </span>
                {Boolean(cloudArn) && (
                  <div className={clsx('text-xs', isLight ? 'text-slate-800' : 'text-slate-300')}>
                    <span className={clsx('block text-[10px] font-semibold', isLight ? 'text-slate-600' : 'text-slate-400')}>Cloud Resource ID / ARN</span>
                    <span className={clsx('font-mono text-[10px] break-all font-medium', isLight ? 'text-blue-800' : 'text-cyan-300')}>{cloudArn}</span>
                  </div>
                )}
                {Boolean(cloudRegion) && (
                  <div className={clsx('text-xs flex justify-between', isLight ? 'text-slate-800' : 'text-slate-300')}>
                    <span className={isLight ? 'text-slate-600' : 'text-slate-400'}>Cloud Region</span>
                    <span className={clsx('font-mono font-medium', isLight ? 'text-blue-800' : 'text-cyan-300')}>{cloudRegion}</span>
                  </div>
                )}
                <div className={clsx('text-xs flex justify-between', isLight ? 'text-slate-800' : 'text-slate-300')}>
                  <span className={isLight ? 'text-slate-600' : 'text-slate-400'}>Source</span>
                  <span className={clsx('font-mono font-medium', isLight ? 'text-slate-800' : 'text-slate-300')}>{cloudSource}</span>
                </div>
              </div>
            )}

            {def.description && (
              <div className={clsx('p-3 rounded-xl border', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
                <span className={clsx('text-[11px] font-bold uppercase tracking-wider block mb-1', isLight ? 'text-slate-700' : 'text-slate-400')}>
                  Description
                </span>
                <p className={clsx('text-xs leading-relaxed', isLight ? 'text-slate-700' : 'text-slate-300')}>{def.description}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'waf' && (
          <div className="space-y-3">
            <div className={clsx('flex items-center justify-between pb-1 border-b', isLight ? 'border-slate-200' : 'border-slate-800')}>
              <span className={clsx('text-xs font-bold flex items-center gap-1.5', isLight ? 'text-slate-900' : 'text-white')}>
                <ShieldCheck className={clsx('w-4 h-4', isLight ? 'text-blue-600' : 'text-cyan-400')} />
                <span>Well-Architected Posture</span>
              </span>
              <span className={clsx('text-[10px] font-mono', isLight ? 'text-slate-500' : 'text-slate-400')}>
                {wafFindings.length} issue{wafFindings.length === 1 ? '' : 's'}
              </span>
            </div>

            {loadingWaf ? (
              <div className={clsx('p-8 text-center text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Scanning resource compliance...
              </div>
            ) : wafFindings.length === 0 ? (
              <div className={clsx('p-6 text-center rounded-xl border', isLight ? 'bg-emerald-50/60 border-emerald-200' : 'bg-slate-950/60 border-slate-800')}>
                <CheckCircle2 className="w-7 h-7 text-emerald-500 mx-auto mb-2" />
                <p className={clsx('text-xs font-semibold', isLight ? 'text-emerald-800' : 'text-emerald-300')}>Architecture Compliant</p>
                <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-600' : 'text-slate-400')}>
                  No Well-Architected violations or misconfigurations detected for this component.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {wafFindings.map((f) => {
                  const isCrit = f.severity === 'critical';
                  const isHigh = f.severity === 'high';
                  return (
                    <div
                      key={f.id}
                      className={clsx(
                        'p-3 rounded-xl border text-xs space-y-2',
                        isCrit
                          ? (isLight ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-rose-950/30 border-rose-500/40 text-rose-200')
                          : isHigh
                          ? (isLight ? 'bg-orange-50 border-orange-200 text-orange-900' : 'bg-orange-950/30 border-orange-500/40 text-orange-200')
                          : (isLight ? 'bg-slate-50 border-slate-200 text-slate-800' : 'bg-slate-950/60 border-slate-800 text-slate-300')
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={clsx(
                              'px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider',
                              isCrit ? (isLight ? 'bg-rose-100 text-rose-800' : 'bg-rose-500/20 text-rose-300') : isHigh ? (isLight ? 'bg-orange-100 text-orange-800' : 'bg-orange-500/20 text-orange-300') : (isLight ? 'bg-amber-100 text-amber-800' : 'bg-amber-500/20 text-amber-300')
                            )}
                          >
                            {f.severity}
                          </span>
                          <span className={clsx('text-[10px] font-medium', isLight ? 'text-slate-600' : 'text-slate-400')}>
                            {f.pillarLabel || f.pillar}
                          </span>
                        </div>
                        {f.pillarRef && (
                          <a
                            href={f.pillarRef}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={clsx('transition-colors', isLight ? 'text-blue-600 hover:text-blue-700' : 'text-cyan-400 hover:text-cyan-300')}
                            title="Official guidance doc"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>

                      <p className={clsx('font-bold text-xs leading-snug', isLight ? 'text-slate-900' : 'text-white')}>{f.title}</p>
                      <p className={clsx('text-[11px] leading-relaxed', isLight ? 'text-slate-600' : 'text-slate-300')}>{f.description}</p>

                      <div className={clsx('p-2 rounded-lg border space-y-1', isLight ? 'bg-white border-slate-200' : 'bg-black/40 border-white/5')}>
                        <span className={clsx('text-[10px] font-bold uppercase tracking-wider block', isLight ? 'text-blue-600' : 'text-cyan-400')}>
                          Remediation
                        </span>
                        <p className={clsx('text-[11px] leading-normal', isLight ? 'text-slate-700' : 'text-slate-300')}>{f.remediation}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className={clsx(
        'p-3.5 border-t flex items-center justify-between text-xs',
        isLight ? 'border-slate-200 bg-slate-50/90 text-slate-600' : 'border-slate-800 bg-slate-950/80 text-slate-400'
      )}>
        <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span className="font-medium">Valid Architecture</span>
        </div>
        <span className={clsx('font-mono text-[10px]', isLight ? 'text-slate-500' : 'text-slate-500')}>
          ID: {node.id.substring(0, 10)}…
        </span>
      </div>
    </div>
  );
}
