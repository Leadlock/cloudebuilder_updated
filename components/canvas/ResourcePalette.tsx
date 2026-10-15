'use client';
import { getResourcesByProvider } from '@/lib/resources';
import { CloudProvider, ResourceCategory, ResourceDefinition } from '@/types';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { useApp } from '@/context/AppContext';
import clsx from 'clsx';
import { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, Layers, GripVertical, Sparkles, ChevronLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

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
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | 'all'>('all');
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [isPaletteCollapsed, setIsPaletteCollapsed] = useState(false);

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

  if (isPaletteCollapsed) {
    return (
      <div
        className={clsx(
          'w-11 border-r flex flex-col items-center py-3 shrink-0 select-none z-10 transition-all duration-200',
          isLight ? 'bg-white border-slate-200' : 'bg-[#161618] border-white/[0.08]'
        )}
      >
        <button
          id="btn-expand-palette"
          onClick={() => setIsPaletteCollapsed(false)}
          title="Expand Resource Palette"
          className={clsx(
            'p-2 rounded-lg border transition-colors shadow-xs',
            isLight
              ? 'bg-slate-100 hover:bg-slate-200 text-[#0078d4] border-slate-300'
              : 'bg-[#242426] hover:bg-[#2c2c2e] text-[#50e6ff] border-white/[0.12]'
          )}
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <div className={clsx('my-3 w-4 h-px', isLight ? 'bg-slate-200' : 'bg-slate-800')} />
        <span
          style={{ writingMode: 'vertical-rl' }}
          className={clsx(
            'text-[11px] font-bold uppercase tracking-widest cursor-pointer transform rotate-180 transition-colors',
            isLight ? 'text-slate-500 hover:text-slate-800' : 'text-slate-500 hover:text-slate-300'
          )}
          onClick={() => setIsPaletteCollapsed(false)}
        >
          Resources ({resources.length})
        </span>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'w-64 border-r flex flex-col shrink-0 select-none z-10 transition-all duration-200',
        isLight ? 'bg-white border-slate-200' : 'bg-[#161618] border-white/[0.08]'
      )}
    >
      {/* Header & Search */}
      <div
        className={clsx(
          'p-3 border-b transition-colors',
          isLight ? 'border-slate-200 bg-slate-50/70' : 'border-white/[0.08] bg-[#141416]'
        )}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-[#0078d4]" />
            <span className={clsx('font-bold text-xs tracking-wider uppercase', isLight ? 'text-slate-900' : 'text-white')}>
              {provider === 'aws' ? 'AWS Services' : provider === 'azure' ? 'Azure Services' : 'Cloud Services'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span
              className={clsx(
                'text-[10px] font-mono px-1.5 py-0.5 rounded border',
                isLight ? 'text-slate-600 bg-slate-100 border-slate-200' : 'text-slate-500 bg-slate-800/60 border-slate-700/50'
              )}
            >
              {resources.length}
            </span>
            <button
              id="btn-collapse-palette"
              onClick={() => setIsPaletteCollapsed(true)}
              className={clsx(
                'p-1 rounded transition-colors ml-1',
                isLight ? 'text-slate-500 hover:text-slate-900 hover:bg-slate-200' : 'text-slate-500 hover:text-white hover:bg-slate-800'
              )}
              title="Collapse resource palette"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Search input */}
        <div className="relative">
          <label htmlFor="resource-search" className="sr-only">Search services</label>
          <Search className={clsx('absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5', isLight ? 'text-slate-400' : 'text-slate-500')} />
          <input
            id="resource-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search EC2, VPC, RDS..."
            className={clsx(
              'w-full border rounded-lg pl-8 pr-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-colors',
              isLight
                ? 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-500'
                : 'bg-slate-900 border-slate-700/80 text-slate-200 placeholder-slate-500 focus:border-cyan-500'
            )}
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
                className={clsx(
                  'w-full flex items-center justify-between px-2 py-1 rounded transition-colors group',
                  isLight
                    ? 'text-slate-700 hover:text-slate-900 hover:bg-slate-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
                )}
              >
                <div className="flex items-center gap-1.5">
                  {isCollapsed ? (
                    <ChevronRight className={clsx('w-3 h-3 transition-colors', isLight ? 'text-slate-400 group-hover:text-cyan-600' : 'text-slate-500 group-hover:text-cyan-400')} />
                  ) : (
                    <ChevronDown className={clsx('w-3 h-3 transition-colors', isLight ? 'text-slate-400 group-hover:text-cyan-600' : 'text-slate-500 group-hover:text-cyan-400')} />
                  )}
                  <span
                    className={clsx(
                      'text-[11px] font-semibold uppercase tracking-wider',
                      isLight ? 'text-slate-700 group-hover:text-slate-900' : 'text-slate-400 group-hover:text-slate-200'
                    )}
                  >
                    {catInfo.title}
                  </span>
                </div>
                <span className={clsx('text-[10px] font-mono', isLight ? 'text-slate-400' : 'text-slate-600')}>
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
                        e.dataTransfer.setData(`application/cloudcraft-${res.type}`, res.type);
                        e.dataTransfer.effectAllowed = 'copy';
                        if (typeof window !== 'undefined') {
                          (window as any).__cloudcraft_dragged_type = res.type;
                        }

                        // Set custom drag preview using actual service icon
                        const existingGhost = document.getElementById('cloudcraft-drag-preview');
                        if (existingGhost) existingGhost.remove();

                        const ghost = document.createElement('div');
                        ghost.id = 'cloudcraft-drag-preview';
                        ghost.style.position = 'fixed';
                        ghost.style.top = '-1000px';
                        ghost.style.left = '-1000px';
                        ghost.style.display = 'flex';
                        ghost.style.alignItems = 'center';
                        ghost.style.gap = '8px';
                        ghost.style.padding = '6px 12px';
                        ghost.style.background = isLight ? '#FFFFFF' : '#0F172A';
                        ghost.style.border = '2px solid #0EA5E9';
                        ghost.style.borderRadius = '10px';
                        ghost.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.2)';
                        ghost.style.color = isLight ? '#0F172A' : '#FFFFFF';
                        ghost.style.fontWeight = 'bold';
                        ghost.style.fontSize = '12px';
                        ghost.style.zIndex = '99999';

                        const iconEl = e.currentTarget.querySelector('.shrink-0');
                        if (iconEl) {
                          ghost.appendChild(iconEl.cloneNode(true));
                        }
                        const labelEl = document.createElement('span');
                        labelEl.innerText = res.label;
                        ghost.appendChild(labelEl);

                        document.body.appendChild(ghost);
                        e.dataTransfer.setDragImage(ghost, 25, 20);
                      }}
                      onDragEnd={() => {
                        if (typeof window !== 'undefined') {
                          (window as any).__cloudcraft_dragged_type = null;
                        }
                        const ghost = document.getElementById('cloudcraft-drag-preview');
                        if (ghost) ghost.remove();
                      }}
                      onClick={() => onAddResource && onAddResource(res.type)}
                      title={`${res.label} — Drag to canvas`}
                      className={clsx(
                        'flex items-center gap-2 px-2.5 py-2 rounded-lg border cursor-grab active:cursor-grabbing group transition-all',
                        isLight
                          ? 'bg-slate-50/80 border-slate-200 hover:bg-[#0078d4]/[0.06] hover:border-[#0078d4]/40 hover:shadow-xs'
                          : 'bg-[#1c1c1e] border-white/[0.08] hover:bg-[#242426] hover:border-[#0078d4]/50 hover:shadow-md'
                      )}
                    >
                      <div
                        className={clsx(
                          'p-1 rounded-md border shrink-0 transition-colors',
                          isLight ? 'bg-white border-slate-200 group-hover:border-[#0078d4]/40' : 'bg-[#141416] border-white/10 group-hover:border-[#0078d4]/40'
                        )}
                      >
                        <CloudServiceIcon
                          provider={res.provider}
                          resourceType={res.type}
                          size={20}
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <p
                            className={clsx(
                              'text-xs font-semibold truncate',
                              isLight ? 'text-slate-800 group-hover:text-[#0078d4]' : 'text-slate-200 group-hover:text-white'
                            )}
                          >
                            {res.label}
                          </p>
                          {res.isContainer && (
                            <span
                              className={clsx(
                                'text-[9px] font-medium px-1.5 py-0.2 rounded border',
                                isLight
                                  ? 'bg-[#0078d4]/10 text-[#005a9e] border-[#0078d4]/30'
                                  : 'bg-[#0078d4]/18 text-[#50e6ff] border-[#0078d4]/40'
                              )}
                            >
                              Container
                            </span>
                          )}
                        </div>
                        <p className={clsx('text-[10px] truncate mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
                          {res.service || res.description || 'Cloud Resource'}
                        </p>
                      </div>

                      <GripVertical
                        className={clsx(
                          'w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity',
                          isLight ? 'text-slate-400 group-hover:text-slate-600' : 'text-slate-700 group-hover:text-slate-400'
                        )}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-500')}>No matching cloud services</p>
            <button
              onClick={() => setSearch('')}
              className="mt-2 text-cyan-600 dark:text-cyan-400 hover:underline text-xs font-medium"
            >
              Clear search filter
            </button>
          </div>
        )}
      </div>

      {/* Palette Footer Tip */}
      <div
        className={clsx(
          'p-2.5 border-t text-[11px] flex items-center justify-between',
          isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-slate-800/80 bg-slate-900/40 text-slate-400'
        )}
      >
        <div className="flex items-center gap-2 truncate">
          <Sparkles className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400 shrink-0" />
          <span className="truncate">Drag services onto canvas</span>
        </div>
      </div>
    </div>
  );
}
