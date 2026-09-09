'use client';
import { useState } from 'react';
import { CanvasNode } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { X, Settings, Network, Info, CheckCircle2, AlertTriangle, Layers } from 'lucide-react';
import clsx from 'clsx';

interface PropertiesPanelProps {
  node: CanvasNode | null;
  onClose: () => void;
  onUpdate: (nodeId: string, config: Record<string, unknown>, label: string) => void;
}

export default function PropertiesPanel({ node, onClose, onUpdate }: PropertiesPanelProps) {
  const [activeTab, setActiveTab] = useState<'config' | 'placement' | 'info'>('config');

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
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
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
