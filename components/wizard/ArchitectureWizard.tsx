'use client';
import { useState, useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { WizardOptions, CloudProvider, Region, Environment, AWS_REGIONS, AZURE_REGIONS, REGION_LABELS } from '@/types';
import { architectureTemplates } from '@/lib/templates';
import { generateFromWizard } from '@/lib/generator';
import { formatCurrency } from '@/lib/currency/formatter';
import { Wand2, ChevronRight, ChevronLeft, Check, Cloud, Database, Shield, DollarSign, Globe, Zap } from 'lucide-react';
import clsx from 'clsx';

const STEPS = ['Provider', 'Template', 'Region', 'Config', 'Review'];

const appTypes = ['Web Application', 'API Backend', 'Microservices', 'Data Platform', 'E-Commerce', 'SaaS', 'Mobile Backend', 'Machine Learning'];
const dbTypes = ['None', 'MySQL', 'PostgreSQL', 'MongoDB', 'SQL Server', 'Redis', 'DynamoDB', 'Cosmos DB'];

function StepIndicator({ step, current, isLight }: { step: number; current: number; isLight: boolean }) {
  const done = current > step;
  const active = current === step;
  return (
    <div className="flex items-center gap-2">
      <div className={clsx(
        'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors',
        done ? 'bg-emerald-600 text-white' : active ? 'bg-blue-600 text-white' : isLight ? 'bg-slate-200 text-slate-600 font-semibold' : 'bg-gray-700 text-gray-500'
      )}>
        {done ? <Check className="w-3.5 h-3.5" /> : step + 1}
      </div>
      <span className={clsx(
        'text-xs font-semibold hidden sm:block', 
        active 
          ? (isLight ? 'text-slate-900' : 'text-white') 
          : done 
            ? (isLight ? 'text-emerald-700' : 'text-emerald-400') 
            : (isLight ? 'text-slate-400' : 'text-gray-600')
      )}>
        {STEPS[step]}
      </span>
    </div>
  );
}

export default function ArchitectureWizard() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';
  const [step, setStep] = useState(0);
  const [generating, setGenerating] = useState(false);

  const activeCurrency = state.displayCurrency || 'USD';
  const [exchangeRate, setExchangeRate] = useState<number>(1.0);

  useEffect(() => {
    if (activeCurrency === 'USD') {
      setExchangeRate(1.0);
      return;
    }
    let cancelled = false;
    fetch(`/api/currency/rates?from=USD&to=${activeCurrency}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.ok && data.data?.rate?.rate) {
          setExchangeRate(data.data.rate.rate);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeCurrency]);
  const [opts, setOpts] = useState<WizardOptions>({
    provider: 'aws',
    templateId: '3tier-web',
    region: 'us-east-1',
    environment: 'production',
    appType: 'Web Application',
    database: 'PostgreSQL',
    highAvailability: false,
    securityLevel: 'standard',
    budget: 'moderate',
    includeMonitoring: false,
    includeWAF: false,
  });
  const [projectName, setProjectName] = useState('My Architecture');

  function set<K extends keyof WizardOptions>(k: K, v: WizardOptions[K]) {
    setOpts((o) => ({ ...o, [k]: v }));
  }

  const regions = opts.provider === 'azure' ? AZURE_REGIONS : opts.provider === 'aws' ? AWS_REGIONS : [...AWS_REGIONS, ...AZURE_REGIONS];
  const filteredTemplates = architectureTemplates.filter((t) =>
    opts.provider === 'multi' ? true : t.provider === opts.provider || t.provider === 'multi'
  );
  const selectedTemplate = filteredTemplates.find((t) => t.id === opts.templateId);

  async function handleGenerate() {
    setGenerating(true);
    await new Promise((r) => setTimeout(r, 1400));
    const { nodes, edges } = generateFromWizard(opts);
    dispatch({ type: 'CREATE_PROJECT', provider: opts.provider, name: projectName, nodes, edges });
    setGenerating(false);
  }

  return (
    <div className={clsx("flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar", isLight ? "bg-slate-50 text-slate-900" : "bg-gray-950 text-slate-100")}>
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-md">
            <Wand2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className={clsx("font-bold text-xl", isLight ? "text-slate-900" : "text-white")}>Architecture Wizard</h1>
            <p className={clsx("text-sm", isLight ? "text-slate-500" : "text-gray-400")}>Generate a cloud architecture in minutes</p>
          </div>
        </div>

        {/* Steps */}
        <div className="flex items-center gap-1 mb-8">
          {STEPS.map((_, i) => (
            <div key={i} className="flex items-center gap-1">
              <StepIndicator step={i} current={step} isLight={isLight} />
              {i < STEPS.length - 1 && (
                <div className={clsx('h-px w-6 mx-1', step > i ? 'bg-emerald-600' : isLight ? 'bg-slate-200' : 'bg-gray-700')} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className={clsx("border rounded-xl p-6 mb-6", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800 border-gray-700")}>

          {/* Step 0: Provider */}
          {step === 0 && (
            <div>
              <h2 className={clsx("font-semibold text-base mb-4", isLight ? "text-slate-900" : "text-white")}>Select Cloud Provider</h2>
              <div className="grid grid-cols-3 gap-3">
                {(['aws', 'azure', 'multi'] as CloudProvider[]).map((p) => {
                  const isSelected = opts.provider === p;
                  return (
                    <button
                      key={p}
                      onClick={() => {
                        set('provider', p);
                        set('region', p === 'azure' ? 'eastus' : 'us-east-1');
                        set('templateId', p === 'azure' ? 'azure-microservices' : p === 'multi' ? 'multicloud' : '3tier-web');
                      }}
                      className={clsx(
                        'flex flex-col items-center gap-3 p-5 rounded-xl border-2 transition-all',
                        isSelected 
                          ? (isLight 
                              ? (p === 'aws' ? 'border-orange-500 bg-orange-50 shadow-sm' : p === 'azure' ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-purple-500 bg-purple-50 shadow-sm')
                              : (p === 'aws' ? 'border-orange-500 bg-orange-900/20' : p === 'azure' ? 'border-blue-500 bg-blue-900/20' : 'border-purple-500 bg-purple-900/20')
                            )
                          : (isLight ? 'border-slate-200 bg-slate-50/50 hover:border-slate-300' : 'border-gray-700 hover:border-gray-600')
                      )}
                    >
                      <div className={clsx(
                        'w-12 h-12 rounded-xl flex items-center justify-center text-sm font-bold', 
                        p === 'aws' ? (isLight ? 'bg-orange-100 text-orange-700' : 'bg-orange-500/20 text-orange-400') : 
                        p === 'azure' ? (isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-500/20 text-blue-400') : 
                        (isLight ? 'bg-purple-100 text-purple-700' : 'bg-purple-500/20 text-purple-400')
                      )}>
                        {p === 'aws' ? 'AWS' : p === 'azure' ? 'AZ' : '☁+☁'}
                      </div>
                      <div className="text-center">
                        <p className={clsx("text-sm font-semibold", isLight ? "text-slate-900" : "text-white")}>{p === 'aws' ? 'Amazon AWS' : p === 'azure' ? 'Microsoft Azure' : 'Multi-cloud'}</p>
                        <p className={clsx("text-xs mt-0.5", isLight ? "text-slate-500" : "text-gray-500")}>{p === 'aws' ? '9 resource types' : p === 'azure' ? '8 resource types' : 'AWS + Azure'}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 1: Template */}
          {step === 1 && (
            <div>
              <h2 className={clsx("font-semibold text-base mb-4", isLight ? "text-slate-900" : "text-white")}>Choose Architecture Template</h2>
              <div className="grid grid-cols-2 gap-3 max-h-[400px] overflow-y-auto pr-1 custom-scrollbar">
                {filteredTemplates.map((t) => {
                  const isSelected = opts.templateId === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => set('templateId', t.id)}
                      className={clsx(
                        'text-left p-4 rounded-xl border-2 transition-all',
                        isSelected 
                          ? (isLight ? 'border-blue-500 bg-blue-50/80 shadow-sm' : 'border-blue-500 bg-blue-900/20')
                          : (isLight ? 'border-slate-200 bg-slate-50/50 hover:border-slate-300' : 'border-gray-700 hover:border-gray-600')
                      )}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <p className={clsx("font-semibold text-sm", isLight ? "text-slate-900" : "text-white")}>{t.name}</p>
                        <span className={clsx(
                          'text-[10px] px-1.5 py-0.5 rounded font-medium',
                          isLight 
                            ? (t.complexity === 'simple' ? 'bg-emerald-100 text-emerald-800' : t.complexity === 'moderate' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800')
                            : (t.complexity === 'simple' ? 'bg-emerald-900 text-emerald-400' : t.complexity === 'moderate' ? 'bg-yellow-900 text-yellow-400' : 'bg-red-900 text-red-400')
                        )}>
                          {t.complexity}
                        </span>
                      </div>
                      <p className={clsx("text-xs mb-3 line-clamp-2", isLight ? "text-slate-600" : "text-gray-500")}>{t.description}</p>
                      <div className={clsx("flex items-center gap-3 text-xs font-medium", isLight ? "text-slate-500" : "text-gray-500")}>
                        <span>{t.resourceCount} resources</span>
                        <span>~{formatCurrency(t.estimatedCost * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2: Region */}
          {step === 2 && (
            <div>
              <h2 className={clsx("font-semibold text-base mb-4", isLight ? "text-slate-900" : "text-white")}>Select Region & Environment</h2>
              <div className="space-y-4">
                <div>
                  <label className={clsx("text-sm mb-2 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Primary Region</label>
                  <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto custom-scrollbar p-1">
                    {regions.map((r) => {
                      const isSelected = opts.region === r;
                      return (
                        <button
                          key={r}
                          onClick={() => set('region', r)}
                          className={clsx(
                            'text-left px-3 py-2.5 rounded-lg border transition-all text-sm',
                            isSelected 
                              ? (isLight ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-xs' : 'border-blue-500 bg-blue-900/20 text-white')
                              : (isLight ? 'border-slate-200 bg-slate-50/50 text-slate-700 hover:border-slate-300' : 'border-gray-700 text-gray-400 hover:border-gray-600 hover:text-white')
                          )}
                        >
                          <p className="font-semibold text-xs">{r}</p>
                          <p className={clsx("text-[10px]", isLight ? "text-slate-500" : "text-gray-600")}>{REGION_LABELS[r]}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className={clsx("text-sm mb-2 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Environment</label>
                  <div className="flex gap-3">
                    {(['production'] as Environment[]).map((e) => (
                      <button key={e} onClick={() => set('environment', e)}
                        className={clsx('flex-1 py-2.5 rounded-lg border text-sm font-semibold capitalize transition-all',
                          opts.environment === e 
                            ? (isLight ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-xs' : 'border-blue-500 bg-blue-900/20 text-white')
                            : (isLight ? 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100' : 'border-gray-700 text-gray-500 hover:border-gray-600')
                        )}>
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Config */}
          {step === 3 && (
            <div>
              <h2 className={clsx("font-semibold text-base mb-4", isLight ? "text-slate-900" : "text-white")}>Architecture Configuration</h2>
              <div className="space-y-4">
                <div>
                  <label className={clsx("text-sm mb-2 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Project Name</label>
                  <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)}
                    className={clsx(
                      "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                      isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-900 border-gray-700 text-white"
                    )} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={clsx("text-sm mb-2 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Application Type</label>
                    <select value={opts.appType} onChange={(e) => set('appType', e.target.value)}
                      className={clsx(
                        "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                        isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-900 border-gray-700 text-white"
                      )}>
                      {appTypes.map((a) => <option key={a}>{a}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={clsx("text-sm mb-2 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Database</label>
                    <select value={opts.database} onChange={(e) => set('database', e.target.value)}
                      className={clsx(
                        "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                        isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-900 border-gray-700 text-white"
                      )}>
                      {dbTypes.map((d) => <option key={d}>{d}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { key: 'securityLevel' as const, label: 'Security Level', options: [['basic', 'Basic'], ['standard', 'Standard'], ['high', 'High']] },
                    { key: 'budget' as const, label: 'Budget', options: [['minimal', 'Minimal'], ['moderate', 'Moderate'], ['unlimited', 'Unlimited']] },
                  ].map(({ key, label, options }) => (
                    <div key={key}>
                      <label className={clsx("text-sm mb-2 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>{label}</label>
                      <select value={opts[key] as string} onChange={(e) => set(key, e.target.value as never)}
                        className={clsx(
                          "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border",
                          isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-900 border-gray-700 text-white"
                        )}>
                        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  {[
                    { key: 'highAvailability' as const, label: 'High Availability', desc: 'Multi-AZ deployment with automatic failover' },
                    { key: 'includeMonitoring' as const, label: 'Include Monitoring', desc: 'CloudWatch dashboards and alerts' },
                    { key: 'includeWAF' as const, label: 'Include WAF', desc: 'Web Application Firewall for internet-facing apps' },
                  ].map(({ key, label, desc }) => (
                    <label key={key} className={clsx(
                      "flex items-center justify-between p-3 rounded-lg cursor-pointer border transition-colors",
                      isLight ? "bg-slate-50 border-slate-200 hover:bg-slate-100/80" : "bg-gray-900 border-transparent hover:bg-gray-900/80"
                    )}>
                      <div>
                        <p className={clsx("text-sm font-semibold", isLight ? "text-slate-900" : "text-white")}>{label}</p>
                        <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-500")}>{desc}</p>
                      </div>
                      <div className="relative">
                        <input type="checkbox" className="sr-only" checked={opts[key] as boolean} onChange={(e) => set(key, e.target.checked as never)} />
                        <div className={clsx('w-10 h-5 rounded-full transition-colors', opts[key] ? 'bg-blue-600' : isLight ? 'bg-slate-300' : 'bg-gray-700')} />
                        <div className={clsx('absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform', opts[key] ? 'translate-x-5' : 'translate-x-0.5')} />
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 4 && (
            <div>
              <h2 className={clsx("font-semibold text-base mb-4", isLight ? "text-slate-900" : "text-white")}>Review & Generate</h2>
              <div className="grid grid-cols-2 gap-4 mb-4">
                {[
                  { label: 'Project', value: projectName },
                  { label: 'Provider', value: opts.provider.toUpperCase() },
                  { label: 'Template', value: selectedTemplate?.name ?? opts.templateId },
                  { label: 'Region', value: opts.region },
                  { label: 'Environment', value: opts.environment },
                  { label: 'HA', value: opts.highAvailability ? 'Enabled' : 'Disabled' },
                ].map(({ label, value }) => (
                  <div key={label} className={clsx("rounded-lg p-3 border", isLight ? "bg-slate-50 border-slate-200" : "bg-gray-900 border-transparent")}>
                    <p className={clsx("text-xs font-medium", isLight ? "text-slate-500" : "text-gray-500")}>{label}</p>
                    <p className={clsx("text-sm font-semibold mt-0.5", isLight ? "text-slate-900" : "text-white")}>{value}</p>
                  </div>
                ))}
              </div>
              {selectedTemplate && (
                <div className={clsx(
                  "border rounded-xl p-4",
                  isLight ? "bg-blue-50/70 border-blue-200 text-blue-900" : "bg-blue-900/20 border-blue-800 text-blue-300"
                )}>
                  <p className={clsx("font-semibold text-sm mb-2", isLight ? "text-blue-900" : "text-blue-300")}>Template: {selectedTemplate.name}</p>
                  <p className={clsx("text-xs mb-3", isLight ? "text-slate-600" : "text-gray-400")}>{selectedTemplate.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTemplate.features.map((f) => (
                      <span key={f} className={clsx(
                        "text-xs px-2 py-0.5 rounded-full font-medium border",
                        isLight ? "bg-white text-blue-700 border-blue-200" : "bg-blue-900/40 text-blue-300 border-blue-800"
                      )}>{f}</span>
                    ))}
                  </div>
                  <div className={clsx("flex gap-4 mt-3 text-xs font-medium", isLight ? "text-slate-600" : "text-gray-400")}>
                    <span>~{selectedTemplate.resourceCount + (opts.highAvailability ? 3 : 0)} resources</span>
                    <span>~{formatCurrency(selectedTemplate.estimatedCost * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo est.</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Nav Sticky Bar */}
        <div className={clsx(
          "sticky bottom-6 z-20 backdrop-blur-xl p-3.5 sm:p-4 rounded-2xl flex items-center justify-between gap-3 border shadow-xl",
          isLight ? "bg-white/90 border-slate-200" : "bg-slate-900/90 border-slate-700/80 shadow-2xl"
        )}>
          <button
            onClick={() => step === 0 ? dispatch({ type: 'SET_VIEW', view: 'dashboard' }) : setStep((s) => s - 1)}
            className={clsx(
              "flex items-center gap-2 px-4 py-2 border rounded-xl text-xs font-semibold transition-all active:scale-[0.98]",
              isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300" : "text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border-slate-600"
            )}
          >
            <ChevronLeft className="w-4 h-4" />
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-[0.98]"
            >
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-2 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all shadow-lg active:scale-[0.98]"
            >
              {generating ? (
                <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Generating...</>
              ) : (
                <><Wand2 className="w-4 h-4" /> Generate Architecture</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
