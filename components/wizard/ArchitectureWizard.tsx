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

function StepIndicator({ step, current }: { step: number; current: number }) {
  const done = current > step;
  const active = current === step;
  return (
    <div className="flex items-center gap-2">
      <div className={clsx(
        'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors',
        done ? 'bg-emerald-600 text-white' : active ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-500'
      )}>
        {done ? <Check className="w-3.5 h-3.5" /> : step + 1}
      </div>
      <span className={clsx('text-xs font-medium hidden sm:block', active ? 'text-white' : done ? 'text-gray-400' : 'text-gray-600')}>
        {STEPS[step]}
      </span>
    </div>
  );
}

export default function ArchitectureWizard() {
  const { state, dispatch } = useApp();
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
    <div className="flex-1 overflow-y-auto bg-gray-900 p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
            <Wand2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-white font-bold text-xl">Architecture Wizard</h1>
            <p className="text-gray-400 text-sm">Generate a cloud architecture in minutes</p>
          </div>
        </div>

        {/* Steps */}
        <div className="flex items-center gap-1 mb-8">
          {STEPS.map((_, i) => (
            <div key={i} className="flex items-center gap-1">
              <StepIndicator step={i} current={step} />
              {i < STEPS.length - 1 && <div className={clsx('h-px w-6 mx-1', step > i ? 'bg-emerald-600' : 'bg-gray-700')} />}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 mb-6">

          {/* Step 0: Provider */}
          {step === 0 && (
            <div>
              <h2 className="text-white font-semibold text-base mb-4">Select Cloud Provider</h2>
              <div className="grid grid-cols-3 gap-3">
                {(['aws', 'azure', 'multi'] as CloudProvider[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      set('provider', p);
                      set('region', p === 'azure' ? 'eastus' : 'us-east-1');
                      set('templateId', p === 'azure' ? 'azure-microservices' : p === 'multi' ? 'multicloud' : '3tier-web');
                    }}
                    className={clsx(
                      'flex flex-col items-center gap-3 p-5 rounded-xl border-2 transition-colors',
                      opts.provider === p ? (p === 'aws' ? 'border-orange-500 bg-orange-900/20' : p === 'azure' ? 'border-blue-500 bg-blue-900/20' : 'border-purple-500 bg-purple-900/20') : 'border-gray-700 hover:border-gray-600'
                    )}
                  >
                    <div className={clsx('w-12 h-12 rounded-xl flex items-center justify-center text-sm font-bold', p === 'aws' ? 'bg-orange-500/20 text-orange-400' : p === 'azure' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400')}>
                      {p === 'aws' ? 'AWS' : p === 'azure' ? 'AZ' : '☁+☁'}
                    </div>
                    <div className="text-center">
                      <p className="text-white text-sm font-semibold">{p === 'aws' ? 'Amazon AWS' : p === 'azure' ? 'Microsoft Azure' : 'Multi-cloud'}</p>
                      <p className="text-gray-500 text-xs mt-0.5">{p === 'aws' ? '9 resource types' : p === 'azure' ? '8 resource types' : 'AWS + Azure'}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 1: Template */}
          {step === 1 && (
            <div>
              <h2 className="text-white font-semibold text-base mb-4">Choose Architecture Template</h2>
              <div className="grid grid-cols-2 gap-3 max-h-[400px] overflow-y-auto pr-1">
                {filteredTemplates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => set('templateId', t.id)}
                    className={clsx(
                      'text-left p-4 rounded-xl border-2 transition-colors',
                      opts.templateId === t.id ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700 hover:border-gray-600'
                    )}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="text-white font-medium text-sm">{t.name}</p>
                      <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium', t.complexity === 'simple' ? 'bg-emerald-900 text-emerald-400' : t.complexity === 'moderate' ? 'bg-yellow-900 text-yellow-400' : 'bg-red-900 text-red-400')}>
                        {t.complexity}
                      </span>
                    </div>
                    <p className="text-gray-500 text-xs mb-3 line-clamp-2">{t.description}</p>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span>{t.resourceCount} resources</span>
                      <span>~{formatCurrency(t.estimatedCost * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Region */}
          {step === 2 && (
            <div>
              <h2 className="text-white font-semibold text-base mb-4">Select Region & Environment</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-gray-400 text-sm mb-2 block">Primary Region</label>
                  <div className="grid grid-cols-2 gap-2">
                    {regions.map((r) => (
                      <button
                        key={r}
                        onClick={() => set('region', r)}
                        className={clsx('text-left px-3 py-2.5 rounded-lg border transition-colors text-sm', opts.region === r ? 'border-blue-500 bg-blue-900/20 text-white' : 'border-gray-700 text-gray-400 hover:border-gray-600 hover:text-white')}
                      >
                        <p className="font-medium text-xs">{r}</p>
                        <p className="text-gray-600 text-[10px]">{REGION_LABELS[r]}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-gray-400 text-sm mb-2 block">Environment</label>
                  <div className="flex gap-3">
                    {(['development', 'staging', 'production'] as Environment[]).map((e) => (
                      <button key={e} onClick={() => set('environment', e)}
                        className={clsx('flex-1 py-2.5 rounded-lg border text-sm font-medium capitalize transition-colors',
                          opts.environment === e ? 'border-blue-500 bg-blue-900/20 text-white' : 'border-gray-700 text-gray-500 hover:border-gray-600'
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
              <h2 className="text-white font-semibold text-base mb-4">Architecture Configuration</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-gray-400 text-sm mb-2 block">Project Name</label>
                  <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">Application Type</label>
                    <select value={opts.appType} onChange={(e) => set('appType', e.target.value)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                      {appTypes.map((a) => <option key={a}>{a}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">Database</label>
                    <select value={opts.database} onChange={(e) => set('database', e.target.value)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                      {dbTypes.map((d) => <option key={d}>{d}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  {[
                    { key: 'securityLevel' as const, label: 'Security Level', options: [['basic', 'Basic'], ['standard', 'Standard'], ['high', 'High']] },
                    { key: 'budget' as const, label: 'Budget', options: [['minimal', 'Minimal'], ['moderate', 'Moderate'], ['unlimited', 'Unlimited']] },
                  ].map(({ key, label, options }) => (
                    <div key={key}>
                      <label className="text-gray-400 text-sm mb-2 block">{label}</label>
                      <select value={opts[key] as string} onChange={(e) => set(key, e.target.value as never)}
                        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
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
                    <label key={key} className="flex items-center justify-between p-3 bg-gray-900 rounded-lg cursor-pointer">
                      <div>
                        <p className="text-white text-sm font-medium">{label}</p>
                        <p className="text-gray-500 text-xs">{desc}</p>
                      </div>
                      <div className="relative">
                        <input type="checkbox" className="sr-only" checked={opts[key] as boolean} onChange={(e) => set(key, e.target.checked as never)} />
                        <div className={clsx('w-10 h-5 rounded-full transition-colors', opts[key] ? 'bg-blue-600' : 'bg-gray-700')} />
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
              <h2 className="text-white font-semibold text-base mb-4">Review & Generate</h2>
              <div className="grid grid-cols-2 gap-4 mb-4">
                {[
                  { label: 'Project', value: projectName },
                  { label: 'Provider', value: opts.provider.toUpperCase() },
                  { label: 'Template', value: selectedTemplate?.name ?? opts.templateId },
                  { label: 'Region', value: opts.region },
                  { label: 'Environment', value: opts.environment },
                  { label: 'HA', value: opts.highAvailability ? 'Enabled' : 'Disabled' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-gray-900 rounded-lg p-3">
                    <p className="text-gray-500 text-xs">{label}</p>
                    <p className="text-white text-sm font-medium mt-0.5">{value}</p>
                  </div>
                ))}
              </div>
              {selectedTemplate && (
                <div className="bg-blue-900/20 border border-blue-800 rounded-xl p-4">
                  <p className="text-blue-300 font-medium text-sm mb-2">Template: {selectedTemplate.name}</p>
                  <p className="text-gray-400 text-xs mb-3">{selectedTemplate.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTemplate.features.map((f) => (
                      <span key={f} className="text-xs bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded-full">{f}</span>
                    ))}
                  </div>
                  <div className="flex gap-4 mt-3 text-xs text-gray-400">
                    <span>~{selectedTemplate.resourceCount + (opts.highAvailability ? 3 : 0)} resources</span>
                    <span>~{formatCurrency(selectedTemplate.estimatedCost * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo est.</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Nav */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => step === 0 ? dispatch({ type: 'SET_VIEW', view: 'dashboard' }) : setStep((s) => s - 1)}
            className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-white border border-gray-700 rounded-lg text-sm transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
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
