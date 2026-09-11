'use client';
import { useState, useEffect } from 'react';
import { CanvasNode } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { X, Settings, Network, Info, CheckCircle2, AlertTriangle, Layers, ShieldCheck, ShieldAlert, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import { useActiveProject } from '@/context/AppContext';
import type { WaFinding } from '@/lib/engines/wellArchitected/types';

interface PropertiesPanelProps {
  node: CanvasNode | null;
  onClose: () => void;
  onUpdate: (nodeId: string, config: Record<string, unknown>, label: string) => void;
}

export default function PropertiesPanel({ node, onClose, onUpdate }: PropertiesPanelProps) {
  const activeProject = useActiveProject();
  const [activeTab, setActiveTab] = useState<'config' | 'placement' | 'info' | 'waf'>('config');
  const [wafFindings, setWafFindings] = useState<WaFinding[]>([]);
  const [loadingWaf, setLoadingWaf] = useState(false);

  useEffect(() => {
    if (!node || !activeProject) return;
    let isCancelled = false;
    setLoadingWaf(true);
    apiWellArchitectedService.getResourceFindings(node.id, activeProject.id).then((findings) => {
      if (!isCancelled) {
        setWafFindings(findings || []);
        setLoadingWaf(false);
      }
    }).catch(() => {
      if (!isCancelled) {
        setWafFindings([]);
        setLoadingWaf(false);
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

  return (
    <div className="w-80 bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 select-none shadow-2xl z-20">
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
          <div className="flex items-center gap-1.5">
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
          <div className="bg-cyan-950/40 border border-cyan-500/40 rounded-xl p-3 flex items-start gap-2.5 text-xs text-cyan-300">
            <AlertTriangle className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-cyan-200">Imported Infrastructure (Read-Only)</p>
              <p className="text-[11px] text-cyan-400/80 mt-0.5 leading-relaxed">
                Discovered live from {provider.toUpperCase()} ({cloudRegion || 'cloud'}). Protected against destructive modification or deletion.
              </p>
            </div>
          </div>
        )}

        {activeTab === 'config' && (
          <div className="space-y-3.5">
            {def.configSchema.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <label className="text-slate-300 text-xs font-medium flex items-center justify-between">
                  <span>
                    {field.label}
                    {field.required && <span className="text-rose-400 ml-1">*</span>}
                  </span>
                  {field.placeholder && (
                    <span className="text-[10px] text-slate-500 font-mono font-normal">
                      {field.placeholder}
                    </span>
                  )}
                </label>

                {field.type === 'boolean' ? (
                  <label className="flex items-center justify-between p-2 rounded-lg bg-slate-950/60 border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                    <span className="text-slate-300 text-xs">
                      {node.config[field.key] ? 'Enabled' : 'Disabled'}
                    </span>
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={Boolean(node.config[field.key] ?? field.defaultValue)}
                        onChange={(e) => handleChange(field.key, e.target.checked)}
                        className="sr-only"
                      />
                      <div
                        className={clsx(
                          'w-9 h-5 rounded-full transition-colors',
                          node.config[field.key] ? 'bg-cyan-600' : 'bg-slate-700'
                        )}
                      />
                      <div
                        className={clsx(
                          'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                          node.config[field.key] ? 'translate-x-4' : 'translate-x-0.5'
                        )}
                      />
                    </div>
                  </label>
                ) : field.type === 'select' ? (
                  <select
                    value={String(node.config[field.key] ?? field.defaultValue)}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
                  >
                    {field.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    value={Number(node.config[field.key] ?? field.defaultValue)}
                    onChange={(e) => handleChange(field.key, Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all font-mono"
                  />
                ) : (
                  <input
                    type="text"
                    value={String(node.config[field.key] ?? field.defaultValue)}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all placeholder-slate-600"
                  />
                )}
              </div>
            ))}
          </div>
        )}

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
