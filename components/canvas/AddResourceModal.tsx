'use client';
import React, { useState, useMemo } from 'react';
import { getResourcesByProvider } from '@/lib/resources';
import { CloudProvider } from '@/types';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { Search, X, Layers, Plus } from 'lucide-react';

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
  const [search, setSearch] = useState('');

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
      <div className="w-full max-w-xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-cyan-400" />
            <h3 className="text-white font-bold text-sm tracking-tight">Add Cloud Resource</h3>
            <span className="text-[10px] font-mono text-slate-400 px-2 py-0.5 rounded bg-slate-800">
              {provider.toUpperCase()}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-slate-800/80 bg-slate-950/40">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, service or category (e.g. EC2, VPC, PostgreSQL, RDS)..."
              className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-9 pr-4 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
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
              className="flex items-start gap-3 p-3 rounded-xl bg-slate-950/50 border border-slate-800 hover:border-cyan-500/50 hover:bg-slate-800/60 transition-all text-left group"
            >
              <div className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 shrink-0 group-hover:border-cyan-500/30 transition-colors">
                <CloudServiceIcon provider={res.provider} resourceType={res.type} size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-slate-200 group-hover:text-white truncate">
                    {res.label}
                  </p>
                  <Plus className="w-3.5 h-3.5 text-slate-500 group-hover:text-cyan-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">
                  {res.service || res.description || 'Cloud Service'}
                </p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 capitalize">
                    {res.category}
                  </span>
                  {res.isContainer && (
                    <span className="text-[9px] font-medium px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300">
                      Container
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}

          {filtered.length === 0 && (
            <div className="col-span-2 py-12 text-center text-slate-500 text-xs">
              No cloud resources found matching &quot;{search}&quot;
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
