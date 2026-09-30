'use client';

import React, { useState, useMemo } from 'react';
import {
  LayoutGrid,
  Search,
  X,
  Check,
  Plus,
  RefreshCw,
  DollarSign,
  Layers,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Server
} from 'lucide-react';
import clsx from 'clsx';
import { architectureTemplates } from '@/lib/templates';
import { instantiateTemplate } from '@/lib/domain/instantiateTemplate';
import { ArchitectureTemplate, CloudProvider, CanvasNode, CanvasEdge } from '@/types';
import { formatCurrency } from '@/lib/currency/formatter';

interface ImportTemplateModalProps {
  isOpen: boolean;
  hasExistingNodes: boolean;
  activeCurrency?: string;
  onClose: () => void;
  onImport: (template: ArchitectureTemplate, mode: 'replace' | 'append') => void;
}

export default function ImportTemplateModal({
  isOpen,
  hasExistingNodes,
  activeCurrency = 'USD',
  onClose,
  onImport,
}: ImportTemplateModalProps) {
  const [providerFilter, setProviderFilter] = useState<'all' | 'aws' | 'azure' | 'multi'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(architectureTemplates[0]?.id || '');
  const [importMode, setImportMode] = useState<'replace' | 'append'>(hasExistingNodes ? 'append' : 'replace');

  const filteredTemplates = useMemo(() => {
    return architectureTemplates.filter((t) => {
      const matchesProvider =
        providerFilter === 'all' ||
        (providerFilter === 'multi' ? t.provider === 'multi' : t.provider === providerFilter || t.provider === 'multi');
      const matchesSearch =
        searchQuery.trim() === '' ||
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.features.some((f) => f.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesProvider && matchesSearch;
    });
  }, [providerFilter, searchQuery]);

  const selectedTemplate = useMemo(() => {
    return architectureTemplates.find((t) => t.id === selectedTemplateId) || filteredTemplates[0] || null;
  }, [selectedTemplateId, filteredTemplates]);

  if (!isOpen) return null;

  const handleConfirmImport = () => {
    if (!selectedTemplate) return;
    onImport(selectedTemplate, importMode);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col text-slate-100 overflow-hidden animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
              <LayoutGrid className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white leading-tight">Import Architecture Template</h2>
              <p className="text-xs text-slate-400">Add production-ready cloud architectures directly to your visual builder</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters & Search */}
        <div className="px-5 py-3 border-b border-slate-800/80 bg-slate-900/50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          {/* Provider Pills */}
          <div className="flex items-center gap-1.5 p-1 bg-slate-950 border border-slate-800 rounded-xl text-xs">
            {(['all', 'aws', 'azure', 'multi'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setProviderFilter(p)}
                className={clsx(
                  'px-3 py-1 rounded-lg font-medium transition-all capitalize',
                  providerFilter === p
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                )}
              >
                {p === 'all' ? 'All Providers' : p === 'multi' ? 'Multi-Cloud' : p.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search templates, services..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
        </div>

        {/* Template List & Details Body */}
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 custom-scrollbar">
          {filteredTemplates.map((t) => {
            const isSelected = (selectedTemplate?.id ?? '') === t.id;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedTemplateId(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedTemplateId(t.id);
                }}
                className={clsx(
                  'p-4 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer relative group',
                  isSelected
                    ? 'bg-blue-950/30 border-blue-500 shadow-md shadow-blue-500/10'
                    : 'bg-slate-950/60 border-slate-800 hover:border-slate-700 hover:bg-slate-950'
                )}
              >
                <div>
                  {/* Top Badges */}
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className={clsx(
                        'text-[10px] uppercase font-bold px-2 py-0.5 rounded border',
                        t.provider === 'aws'
                          ? 'bg-orange-500/10 text-orange-400 border-orange-500/30'
                          : t.provider === 'azure'
                          ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                          : 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                      )}
                    >
                      {t.provider === 'aws' ? 'AWS' : t.provider === 'azure' ? 'Azure' : 'Multi-Cloud'}
                    </span>
                    <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                      <Layers className="w-3 h-3 text-slate-500" />
                      {t.resourceCount} nodes
                    </span>
                  </div>

                  {/* Title & Description */}
                  <h3 className="text-sm font-bold text-white mb-1 group-hover:text-blue-300 transition-colors leading-snug">
                    {t.name}
                  </h3>
                  <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed mb-3">
                    {t.description}
                  </p>
                </div>

                {/* Features & Cost */}
                <div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {t.features.slice(0, 3).map((f) => (
                      <span key={f} className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-300 rounded font-medium">
                        {f}
                      </span>
                    ))}
                    {t.features.length > 3 && (
                      <span className="text-[10px] px-1 py-0.5 text-slate-500">
                        +{t.features.length - 3}
                      </span>
                    )}
                  </div>

                  <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
                    <span className="text-slate-500">Est. Cost</span>
                    <span className="font-semibold text-emerald-400">
                      ~{formatCurrency(t.estimatedCost, activeCurrency)}/mo
                    </span>
                  </div>
                </div>

                {/* Selected Indicator */}
                {isSelected && (
                  <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-blue-500 text-white flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 stroke-[3]" />
                  </div>
                )}
              </div>
            );
          })}

          {filteredTemplates.length === 0 && (
            <div className="col-span-full py-12 text-center text-slate-500 text-xs">
              No architecture templates match your search query.
            </div>
          )}
        </div>

        {/* Footer with Import Mode & Action */}
        <div className="px-5 py-4 border-t border-slate-800 bg-slate-950/80 flex flex-wrap items-center justify-between gap-4 shrink-0">
          {/* Import Mode Radio (only relevant if canvas already has nodes) */}
          <div className="flex items-center gap-3">
            {hasExistingNodes ? (
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 p-1 rounded-xl text-xs">
                <button
                  type="button"
                  onClick={() => setImportMode('append')}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all',
                    importMode === 'append' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                  )}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Insert into Canvas</span>
                </button>
                <button
                  type="button"
                  onClick={() => setImportMode('replace')}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all',
                    importMode === 'replace' ? 'bg-rose-600/90 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                  )}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Replace Canvas</span>
                </button>
              </div>
            ) : (
              <span className="text-xs text-slate-400">
                Selected: <strong className="text-white">{selectedTemplate?.name || 'None'}</strong>
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmImport}
              disabled={!selectedTemplate}
              className="px-5 py-2 text-xs font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 active:from-blue-700 active:to-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl shadow-lg shadow-blue-600/20 flex items-center gap-2 transition-all cursor-pointer"
            >
              <span>Import Template</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
