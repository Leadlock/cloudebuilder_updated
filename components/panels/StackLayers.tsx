'use client';
/**
 * The Stack of Container Templates: Frontend, Backend, API and Database, each with its own tick and its own list of choices. They are independent:
 * choosing or ticking one never changes another. Everything that is ticked is generated together, as one set of files.
 */
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import { currentOption, optionsFor } from '@/lib/engines/containers/stackOptions';
import { enabledLayers, LAYERS, LAYER_LABEL, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';

const HINT: Record<Layer, string> = {
  frontend: 'Web pages and single-page apps.',
  backend: 'Application servers.',
  api: 'Services that answer requests from other programs.',
  database: 'A database or queue, from its official image.',
};

export default function StackLayers({ stack, active, onToggle, onPick, onActive, onName }: {
  stack: StackProject;
  active: Layer;
  onToggle: (layer: Layer, on: boolean) => void;
  onPick: (layer: Layer, optionId: string) => void;
  onActive: (layer: Layer) => void;
  onName: (name: string) => void;
}) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const on = enabledLayers(stack);
  const multi = on.length > 1;
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const label = clsx('block text-xs font-medium mb-1', isLight ? 'text-slate-700' : 'text-slate-300');
  const input = clsx('w-full rounded-lg border px-3 py-2 text-sm', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100');

  return (
    <div className="space-y-3" data-testid="stack-picker">
      <div>
        <p className={label}>Stack</p>
        <p className={clsx('text-[11px]', muted)}>
          Tick every part you need. They are generated together as one set of files and one <code>docker-compose.yml</code>; choosing one never changes another.
        </p>
      </div>

      <div role="group" aria-label="Stack services" className="space-y-2">
        {LAYERS.map((layer) => {
          const { enabled, config } = stack.layers[layer];
          const option = currentOption(config, layer);
          const isOnly = enabled && on.length === 1;
          return (
            <div key={layer} className={clsx('rounded-xl border p-2.5', enabled ? (isLight ? 'border-cyan-300 bg-cyan-50/40' : 'border-cyan-500/40 bg-cyan-500/5') : (isLight ? 'border-slate-200 bg-white' : 'border-slate-800 bg-slate-900/60'))}>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs font-semibold">
                  <input type="checkbox" checked={enabled} disabled={isOnly} aria-label={`Include ${LAYER_LABEL[layer]}`} title={isOnly ? 'At least one part is needed' : HINT[layer]}
                    onChange={(e) => onToggle(layer, e.target.checked)} />
                  {LAYER_LABEL[layer]}
                </label>
                {enabled && multi && (
                  <button type="button" aria-pressed={active === layer} onClick={() => onActive(layer)}
                    className={clsx('text-[11px] rounded-md border px-2 py-0.5 font-medium',
                      active === layer ? (isLight ? 'bg-cyan-600 border-cyan-600 text-white' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200') : (isLight ? 'bg-white border-slate-300 text-slate-700' : 'bg-slate-900 border-slate-700 text-slate-300'))}>
                    {active === layer ? 'Editing below' : 'Edit settings'}
                  </button>
                )}
              </div>
              <select aria-label={`${LAYER_LABEL[layer]} choice`} className={clsx(input, 'mt-2', !enabled && 'opacity-50')} disabled={!enabled}
                value={option?.id ?? ''} onChange={(e) => onPick(layer, e.target.value)}>
                {!option && <option value="" disabled>Choose one…</option>}
                {optionsFor(layer).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          );
        })}
      </div>

      {multi && (
        <div>
          <label className={label} htmlFor="ct-project-name">Project name</label>
          <input id="ct-project-name" className={input} value={stack.name} onChange={(e) => onName(e.target.value)} />
          <p className={clsx('text-[11px] mt-1', muted)}>Each part is named after it, for example <code>{stack.name || 'my-app'}-api</code>. {on.length} parts selected: the files below cover all of them. They run together with Docker Compose, or on one EC2 server (choose where to deploy below).</p>
        </div>
      )}
    </div>
  );
}
