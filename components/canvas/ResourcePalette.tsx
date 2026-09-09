'use client';
import { getResourcesByProvider } from '@/lib/resources';
import { CloudProvider, ResourceCategory, ResourceDefinition } from '@/types';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import clsx from 'clsx';
import { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, Layers, GripVertical, Sparkles } from 'lucide-react';

const categoryLabels: Record<ResourceCategory, { title: string; order: number }> = {
  compute:       { title: 'Compute', order: 1 },
  networking:    { title: 'Networking & Content Delivery', order: 2 },
  loadbalancing: { title: 'Load Balancing', order: 3 },
  database:      { title: 'Database', order: 4 },
  storage:       { title: 'Storage', order: 5 },
  security:      { title: 'Security, Identity & Compliance', order: 6 },
  serverless:    { title: 'Serverless', order: 7 },
  monitoring:    { title: 'Management & Governance', order: 8 },
  messaging:     { title: 'Messaging & Integration', order: 9 },
  ai:            { title: 'AI / Machine Learning', order: 10 },
};

interface ResourcePaletteProps {
  provider: CloudProvider;
  onAddResource?: (type: string) => void;
}

export default function ResourcePalette({ provider, onAddResource }: ResourcePaletteProps) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | 'all'>('all');
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});

  const resources = useMemo(() => {
    return getResourcesByProvider(provider);
  }, [provider]);

  const filtered = useMemo(() => {
    return resources.filter((r) => {
      const matchesSearch =
        r.label.toLowerCase().includes(search.toLowerCase()) ||
        r.type.toLowerCase().includes(search.toLowerCase()) ||
        (r.service || '').toLowerCase().includes(search.toLowerCase());
      const matchesCat = activeCategory === 'all' || r.category === activeCategory;
      return matchesSearch && matchesCat;
    });
  }, [resources, search, activeCategory]);

  const grouped = useMemo(() => {
    const map: Record<string, ResourceDefinition[]> = {};
    for (const item of filtered) {
      map[item.category] = map[item.category] || [];
      map[item.category].push(item);
    }
    return map;
  }, [filtered]);

  const sortedCategories = useMemo(() => {
    return Object.keys(grouped).sort((a, b) => {
      const ordA = categoryLabels[a as ResourceCategory]?.order ?? 99;
      const ordB = categoryLabels[b as ResourceCategory]?.order ?? 99;
      return ordA - ordB;
    });
  }, [grouped]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  return (
    <div className="w-64 bg-slate-950 border-r border-slate-800/80 flex flex-col shrink-0 select-none z-10">
      {/* Header & Search */}
      <div className="p-3 border-b border-slate-800/80 bg-slate-900/40">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-cyan-400" />
            <span className="text-white font-bold text-xs tracking-wider uppercase">
              {provider === 'aws' ? 'AWS Services' : provider === 'azure' ? 'Azure Services' : 'Cloud Services'}
            </span>
          </div>
          <span className="text-[10px] font-mono text-slate-500 bg-slate-800/60 px-1.5 py-0.5 rounded">
            {resources.length}
          </span>
        </div>

        {/* Search input */}
        <div className="relative">
          <label htmlFor="resource-search" className="sr-only">Search services</label>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input
            id="resource-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search EC2, VPC, RDS..."
            className="w-full bg-slate-900 border border-slate-700/80 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
          />
        </div>
      </div>

      {/* Catalog List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3 custom-scrollbar">
        {sortedCategories.map((category) => {
          const items = grouped[category] || [];
          const isCollapsed = collapsedCategories[category];
          const catInfo = categoryLabels[category as ResourceCategory] || { title: category };

          return (
            <div key={category} className="space-y-1">
              <button
                onClick={() => toggleCategory(category)}
                className="w-full flex items-center justify-between px-2 py-1 text-slate-400 hover:text-slate-200 hover:bg-slate-900/50 rounded transition-colors group"
              >
                <div className="flex items-center gap-1.5">
                  {isCollapsed ? (
                    <ChevronRight className="w-3 h-3 text-slate-500 group-hover:text-cyan-400" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-slate-500 group-hover:text-cyan-400" />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 group-hover:text-slate-200">
                    {catInfo.title}
                  </span>
                </div>
                <span className="text-[10px] text-slate-600 font-mono">
                  {items.length}
                </span>
              </button>

              {!isCollapsed && (
                <div className="space-y-1 pt-0.5">
                  {items.map((res) => (
                    <div
                      key={res.type}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/cloudcraft', res.type);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => onAddResource && onAddResource(res.type)}
                      title={`${res.label} — Drag to canvas`}
                      className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-slate-900/40 border border-slate-800/60 hover:bg-slate-800/80 hover:border-slate-600/80 hover:shadow-md cursor-grab active:cursor-grabbing group transition-all"
                    >
                      <div className="p-1 rounded-md bg-slate-950/80 border border-slate-800 shrink-0 group-hover:border-slate-700 transition-colors">
                        <CloudServiceIcon
                          provider={res.provider}
                          resourceType={res.type}
                          size={20}
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-slate-200 group-hover:text-white truncate">
                            {res.label}
                          </p>
                          {res.isContainer && (
                            <span className="text-[9px] font-medium px-1 py-0.2 rounded bg-purple-500/20 text-purple-300">
                              Container
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">
                          {res.service || res.description || 'Cloud Resource'}
                        </p>
                      </div>

                      <GripVertical className="w-3 h-3 text-slate-700 group-hover:text-slate-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className="text-slate-500 text-xs">No matching cloud services</p>
            <button
              onClick={() => setSearch('')}
              className="mt-2 text-cyan-400 hover:text-cyan-300 text-xs font-medium"
            >
              Clear search filter
            </button>
          </div>
        )}
      </div>

      {/* Palette Footer Tip */}
      <div className="p-2.5 border-t border-slate-800/80 bg-slate-900/40 text-[11px] text-slate-400 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span className="truncate">Drag services onto canvas or containers</span>
      </div>
    </div>
  );
}
