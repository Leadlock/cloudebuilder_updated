'use client';
import React, { useState, useMemo } from 'react';
import { useEscapeKey } from '@/lib/ui/useEscapeKey';
import { getResourcesByProvider } from '@/lib/resources';
import { CloudProvider } from '@/types';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { useApp } from '@/context/AppContext';
import { Search, X, Layers, Plus } from 'lucide-react';
import clsx from 'clsx';

interface AddResourceModalProps {
  isOpen: boolean;
  provider: CloudProvider;
  onClose: () => void;
  onSelectResource: (resourceType: string) => void;
}

export default function AddResourceModal({
  isOpen,
  provider,
  onClose,
  onSelectResource,
}: AddResourceModalProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const [search, setSearch] = useState('');
  useEscapeKey(isOpen ? onClose : undefined);

  const resources = useMemo(() => {
    return getResourcesByProvider(provider);
  }, [provider]);

  const filtered = useMemo(() => {
    if (!search.trim()) return resources;
    return resources.filter((r) =>
      r.label.toLowerCase().includes(search.toLowerCase()) ||
      r.type.toLowerCase().includes(search.toLowerCase()) ||
      (r.service || '').toLowerCase().includes(search.toLowerCase()) ||
      r.category.toLowerCase().includes(search.toLowerCase())
    );
  }, [resources, search]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className={clsx(
        'w-full max-w-xl border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]',
        isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-slate-900 border-slate-700/80 text-white'
      )}>
        {/* Header */}
        <div className={clsx(
          'flex items-center justify-between px-5 py-4 border-b',
          isLight ? 'border-slate-200 bg-slate-50' : 'border-slate-800 bg-slate-950/40'
        )}>
          <div className="flex items-center gap-2">
            <Layers className={clsx('w-5 h-5', isLight ? 'text-blue-600' : 'text-cyan-400')} />
            <h3 className={clsx('font-bold text-sm tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>Add Cloud Resource</h3>
            <span className={clsx('text-[10px] font-mono px-2 py-0.5 rounded border', isLight ? 'bg-slate-200 border-slate-300 text-slate-700' : 'bg-slate-800 border-slate-700 text-slate-400')}>
              {provider.toUpperCase()}
            </span>
          </div>
          <button
            onClick={onClose}
            className={clsx('p-1 rounded-lg transition-colors', isLight ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100' : 'text-slate-400 hover:text-white hover:bg-slate-800')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className={clsx('p-4 border-b', isLight ? 'border-slate-200 bg-slate-50/50' : 'border-slate-800/80 bg-slate-950/40')}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, service or category (e.g. EC2, VPC, PostgreSQL, RDS)..."
              className={clsx(
                'w-full border rounded-xl pl-9 pr-4 py-2 text-sm transition-all focus:outline-none',
                isLight
                  ? 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                  : 'bg-slate-900 border-slate-700 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500'
              )}
            />
          </div>
        </div>

        {/* Results Grid */}
        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-2.5 custom-scrollbar">
          {filtered.map((res) => (
            <button
              key={res.type}
              onClick={() => {
                onSelectResource(res.type);
                onClose();
              }}
              className={clsx(
                'flex items-start gap-3 p-3 rounded-xl border transition-all text-left group',
                isLight
                  ? 'bg-slate-50 border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 text-slate-900'
                  : 'bg-slate-950/50 border-slate-800 hover:border-cyan-500/50 hover:bg-slate-800/60 text-slate-200'
              )}
            >
              <div className={clsx(
                'p-1.5 rounded-lg border shrink-0 transition-colors',
                isLight
                  ? 'bg-white border-slate-200 group-hover:border-blue-300'
                  : 'bg-slate-900 border-slate-800 group-hover:border-cyan-500/30'
              )}>
                <CloudServiceIcon provider={res.provider} resourceType={res.type} size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <p className={clsx('text-xs font-bold truncate', isLight ? 'text-slate-900 group-hover:text-blue-700' : 'text-slate-200 group-hover:text-white')}>
                    {res.label}
                  </p>
                  <Plus className={clsx('w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity', isLight ? 'text-blue-600' : 'text-cyan-400')} />
                </div>
                <p className={clsx('text-[10px] truncate mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
                  {res.service || res.description || 'Cloud Service'}
                </p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className={clsx('text-[9px] font-mono px-1.5 py-0.2 rounded capitalize', isLight ? 'bg-slate-200 text-slate-700' : 'bg-slate-800 text-slate-400')}>
                    {res.category}
                  </span>
                  {res.isContainer && (
                    <span className={clsx('text-[9px] font-medium px-1.5 py-0.2 rounded', isLight ? 'bg-purple-100 text-purple-700' : 'bg-purple-500/20 text-purple-300')}>
                      Container
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}

          {filtered.length === 0 && (
            <div className={clsx('col-span-2 py-12 text-center text-xs', isLight ? 'text-slate-500' : 'text-slate-500')}>
              No cloud resources found matching &quot;{search}&quot;
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
