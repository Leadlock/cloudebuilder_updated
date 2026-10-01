'use client';
import { useState, useEffect } from 'react';
import { CanvasNode, ConfigField } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { X, Settings, Network, Info, CheckCircle2, AlertTriangle, Layers, ShieldCheck, ShieldAlert, ExternalLink, Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import { useActiveProject } from '@/context/AppContext';
import type { WaFinding } from '@/lib/engines/wellArchitected/types';

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
}: {
  field: ConfigField;
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const value = config[field.key] ?? field.defaultValue;

  if (field.type === 'boolean') {
    return (
      <label className="flex items-center justify-between p-2 rounded-lg bg-slate-950/60 border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
        <span className="text-slate-300 text-xs">{value ? 'Enabled' : 'Disabled'}</span>
        <div className="relative">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(field.key, e.target.checked)}
            className="sr-only"
          />
          <div className={clsx('w-9 h-5 rounded-full transition-colors', value ? 'bg-cyan-600' : 'bg-slate-700')} />
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
    return (
      <select
        value={String(value)}
        onChange={(e) => onChange(field.key, e.target.value)}
        className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
      >
        {field.options?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
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
                  ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300'
                  : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700'
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
            <span key={`${tag}-${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 text-[11px] text-slate-200">
              {tag}
              <button type="button" onClick={() => onChange(field.key, tags.filter((_, idx) => idx !== i))} className="text-slate-500 hover:text-rose-400">
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
          className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all placeholder-slate-600"
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
              className="w-1/2 bg-slate-950 border border-slate-700/80 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-cyan-500 font-mono"
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
              className="w-1/2 bg-slate-950 border border-slate-700/80 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-cyan-500 font-mono"
            />
            <button type="button" onClick={() => setRows(rows.filter((_, idx) => idx !== i))} className="text-slate-500 hover:text-rose-400 shrink-0">
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setRows([...rows, ['', '']])}
          className="text-[11px] text-cyan-400 hover:text-cyan-300 font-medium"
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
        className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all font-mono"
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
        'w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all placeholder-slate-600',
        field.type === 'cidr' && 'font-mono'
      )}
    />
  );
}

export default function PropertiesPanel({ node, onClose, onUpdate }: PropertiesPanelProps) {
  const activeProject = useActiveProject();
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

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
    <div className="w-full sm:w-80 sm:relative fixed inset-y-0 right-0 z-40 sm:z-20 bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 select-none shadow-2xl animate-in slide-in-from-right duration-150">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-800 bg-slate-950/60">
        <div className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 shrink-0">
          <CloudServiceIcon
            provider={provider}
            resourceType={node.resourceType}
            size={24}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-white text-sm font-bold truncate leading-tight">{node.label}</p>
            {isContainer && (
              <span className="text-[9px] px-1 py-0.2 rounded bg-purple-500/20 text-purple-300 font-medium">
                Container
              </span>
            )}
            {isImported && (
              <span className="text-[9px] px-1 py-0.2 rounded bg-cyan-500/20 text-cyan-300 font-medium">
                Imported
              </span>
            )}
            {normalizedStatus && (
              <span
                className={clsx(
                  'text-[8px] font-bold px-1.5 py-0.2 rounded uppercase tracking-wider',
                  isDeleted ? 'bg-slate-800 text-slate-300 border border-slate-600' :
                  isDeleting ? 'bg-rose-950 text-rose-300 border border-rose-500/40 animate-pulse' :
                  isStopped ? 'bg-amber-950 text-amber-300 border border-amber-500/40' :
                  isPending ? 'bg-sky-950 text-sky-300 border border-sky-500/40 animate-pulse' :
                  isFailed ? 'bg-rose-950 text-rose-300 border border-rose-500/40' :
                  'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                )}
              >
                {normalizedStatus}
              </span>
            )}
          </div>
          <p className="text-slate-400 text-[11px] truncate mt-0.5">
            {def.service || def.label}
          </p>
        </div>

        <button
          onClick={onClose}
          className="text-slate-500 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center px-4 border-b border-slate-800 bg-slate-950/30 text-xs">
        <button
          onClick={() => setActiveTab('config')}
          className={clsx(
            'py-2.5 px-3 border-b-2 font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'config'
              ? 'border-cyan-400 text-cyan-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
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
              ? 'border-cyan-400 text-cyan-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
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
              ? 'border-cyan-400 text-cyan-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
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
              ? 'border-cyan-400 text-cyan-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          )}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>WAF</span>
          {wafFindings.length > 0 && (
            <span
              className={clsx(
                'px-1 py-0.2 rounded-full text-[9px] font-bold leading-none',
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
        {isImported && (
          <div className="p-3 rounded-xl bg-slate-950/80 border border-cyan-500/40 space-y-2.5 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-300">
                  Live Cloud Resource
                </span>
              </div>
              <span
                className={clsx(
                  'text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full flex items-center gap-1',
                  isDeleted ? 'bg-slate-800 text-slate-300 border border-slate-600' :
                  isDeleting ? 'bg-rose-950 text-rose-300 border border-rose-500/40 animate-pulse' :
                  isStopped ? 'bg-amber-950 text-amber-300 border border-amber-500/40' :
                  isPending ? 'bg-sky-950 text-sky-300 border border-sky-500/40 animate-pulse' :
                  isFailed ? 'bg-rose-950 text-rose-300 border border-rose-500/40' :
                  'bg-emerald-950/90 text-emerald-300 border border-emerald-500/40'
                )}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full', isDeleted ? 'bg-slate-400' : isDeleting || isFailed ? 'bg-rose-400' : isStopped ? 'bg-amber-400' : isPending ? 'bg-sky-400' : 'bg-emerald-400')} />
                {normalizedStatus || 'Available'}
              </span>
            </div>

            {Boolean(cloudResourceId) && (
              <div className="flex items-center justify-between text-xs bg-slate-900/90 p-2 rounded-lg border border-slate-800">
                <div className="min-w-0 flex-1 pr-2">
                  <span className="text-[10px] text-slate-500 block">Resource ID</span>
                  <span className="font-mono text-xs text-white truncate block font-medium">
                    {cloudResourceId}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(cloudResourceId, 'id')}
                  className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors shrink-0"
                  title="Copy Resource ID"
                >
                  {copiedKey === 'id' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}

            {Boolean(cloudArn) && cloudArn !== cloudResourceId && (
              <div className="flex items-start justify-between text-xs bg-slate-900/90 p-2 rounded-lg border border-slate-800">
                <div className="min-w-0 flex-1 pr-2">
                  <span className="text-[10px] text-slate-500 block">Cloud ARN</span>
                  <span className="font-mono text-[10px] text-cyan-300 break-all leading-tight block">
                    {cloudArn}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(cloudArn, 'arn')}
                  className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 transition-colors shrink-0 mt-1"
                  title="Copy ARN"
                >
                  {copiedKey === 'arn' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
              <span>Region: <strong className="text-slate-300 font-mono">{cloudRegion || 'us-east-1'}</strong></span>
              <span>Provider: <strong className="text-amber-400">{provider.toUpperCase()}</strong></span>
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
                    <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-800 pb-1.5">
                      {section}
                    </h3>
                    <div className="space-y-3.5">
                      {shown.map((field) => (
                        <div key={field.key} className="space-y-1.5">
                          <label className="text-slate-300 text-xs font-medium flex items-center justify-between">
                            <span className="flex items-center gap-1">
                              {field.label}
                              {field.required && <span className="text-rose-400">*</span>}
                              {field.description && (
                                <span title={field.description} className="text-slate-600 hover:text-slate-400 cursor-help">
                                  <Info className="w-3 h-3" />
                                </span>
                              )}
                            </span>
                            {field.placeholder && field.type !== 'tags' && (
                              <span className="text-[10px] text-slate-500 font-mono font-normal">
                                {field.placeholder}
                              </span>
                            )}
                          </label>
                          <ConfigFieldInput field={field} config={node.config} onChange={handleChange} />
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
                  className="w-full text-center text-[11px] font-semibold text-cyan-400 hover:text-cyan-300 py-2 rounded-lg border border-dashed border-slate-700 hover:border-cyan-500/50 transition-colors"
                >
                  Show {hiddenAdvancedCount} advanced setting{hiddenAdvancedCount === 1 ? '' : 's'}
                </button>
              )}
              {showAdvanced && def.configSchema.some((f) => f.advanced) && (
                <button
                  type="button"
                  onClick={() => setShowAdvanced(false)}
                  className="w-full text-center text-[11px] font-semibold text-slate-500 hover:text-slate-300 py-2 rounded-lg border border-dashed border-slate-800 transition-colors"
                >
                  Hide advanced settings
                </button>
              )}
            </div>
          );
        })()}

        {activeTab === 'placement' && (
          <div className="space-y-3">
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">
                Container Hierarchy
              </span>
              <div className="text-xs text-slate-300 flex items-center justify-between">
                <span className="text-slate-500">Parent Container</span>
                <span className="font-mono text-cyan-400">
                  {node.groupId ? node.groupId.substring(0, 16) : 'Standalone (No Parent)'}
                </span>
              </div>
              <div className="text-xs text-slate-300 flex items-center justify-between">
                <span className="text-slate-500">Container Type</span>
                <span className="font-medium text-slate-300">
                  {isVpc ? 'VPC / VNet Boundary' : isSubnet ? 'Subnet Boundary' : 'Leaf Resource'}
                </span>
              </div>
              {Boolean(node.config.subnetName) && (
                <div className="text-xs text-slate-300 flex items-center justify-between">
                  <span className="text-slate-500">Subnet Binding</span>
                  <span className="font-semibold text-emerald-400">{String(node.config.subnetName)}</span>
                </div>
              )}
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">
                Position & Dimensions
              </span>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono text-slate-300">
                <div className="p-2 rounded bg-slate-900 border border-slate-800">
                  <span className="text-slate-500 block text-[10px]">X Position</span>
                  {Math.round(node.position.x)} px
                </div>
                <div className="p-2 rounded bg-slate-900 border border-slate-800">
                  <span className="text-slate-500 block text-[10px]">Y Position</span>
                  {Math.round(node.position.y)} px
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'info' && (
          <div className="space-y-3">
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">
                Resource Specs
              </span>
              <div className="text-xs text-slate-300 flex justify-between">
                <span className="text-slate-500">Resource Type</span>
                <span className="font-mono text-slate-300">{node.resourceType}</span>
              </div>
              <div className="text-xs text-slate-300 flex justify-between">
                <span className="text-slate-500">Provider</span>
                <span className="font-bold text-amber-400">{provider.toUpperCase()}</span>
              </div>
              <div className="text-xs text-slate-300 flex justify-between">
                <span className="text-slate-500">Est. Base Cost</span>
                <span className="font-semibold text-emerald-400">
                  {def.monthlyBaseCost > 0 ? `$${def.monthlyBaseCost.toFixed(2)} / mo` : 'Free Tier'}
                </span>
              </div>
            </div>

            {isImported && (
              <div className="p-3 rounded-xl bg-slate-950/60 border border-cyan-500/30 space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-400 block">
                  Cloud Identity (Live)
                </span>
                {Boolean(cloudArn) && (
                  <div className="text-xs text-slate-300">
                    <span className="text-slate-500 block text-[10px]">Cloud Resource ID / ARN</span>
                    <span className="font-mono text-[10px] text-cyan-300 break-all">{cloudArn}</span>
                  </div>
                )}
                {Boolean(cloudRegion) && (
                  <div className="text-xs text-slate-300 flex justify-between">
                    <span className="text-slate-500">Cloud Region</span>
                    <span className="font-mono text-cyan-300">{cloudRegion}</span>
                  </div>
                )}
                <div className="text-xs text-slate-300 flex justify-between">
                  <span className="text-slate-500">Source</span>
                  <span className="font-mono text-slate-400">{cloudSource}</span>
                </div>
              </div>
            )}

            {def.description && (
              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                  Description
                </span>
                <p className="text-xs text-slate-400 leading-relaxed">{def.description}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'waf' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-slate-800">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-cyan-400" />
                <span>Well-Architected Posture</span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono">
                {wafFindings.length} issue{wafFindings.length === 1 ? '' : 's'}
              </span>
            </div>

            {loadingWaf ? (
              <div className="p-8 text-center text-slate-400 text-xs">
                Scanning resource compliance...
              </div>
            ) : wafFindings.length === 0 ? (
              <div className="p-6 text-center rounded-xl bg-slate-950/60 border border-slate-800">
                <CheckCircle2 className="w-7 h-7 text-emerald-400 mx-auto mb-2" />
                <p className="text-xs font-semibold text-emerald-300">Architecture Compliant</p>
                <p className="text-[11px] text-slate-400 mt-1">
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
                          ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                          : isHigh
                          ? 'bg-orange-950/30 border-orange-500/40 text-orange-200'
                          : 'bg-slate-950/60 border-slate-800 text-slate-300'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={clsx(
                              'px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider',
                              isCrit ? 'bg-rose-500/20 text-rose-300' : isHigh ? 'bg-orange-500/20 text-orange-300' : 'bg-amber-500/20 text-amber-300'
                            )}
                          >
                            {f.severity}
                          </span>
                          <span className="text-[10px] text-slate-400 font-medium">
                            {f.pillarLabel || f.pillar}
                          </span>
                        </div>
                        {f.pillarRef && (
                          <a
                            href={f.pillarRef}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-400 hover:text-cyan-300"
                            title="Official guidance doc"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>

                      <p className="font-bold text-xs text-white leading-snug">{f.title}</p>
                      <p className="text-[11px] text-slate-300 leading-relaxed">{f.description}</p>

                      <div className="p-2 rounded-lg bg-black/40 border border-white/5 space-y-1">
                        <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider block">
                          Remediation
                        </span>
                        <p className="text-[11px] text-slate-300 leading-normal">{f.remediation}</p>
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
      <div className="p-3.5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-emerald-400">
          <CheckCircle2 className="w-4 h-4" />
          <span className="font-medium">Valid Architecture</span>
        </div>
        <span className="text-slate-500 font-mono text-[10px]">
          ID: {node.id.substring(0, 10)}…
        </span>
      </div>
    </div>
  );
}
