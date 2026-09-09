'use client';
import { useState } from 'react';
import { useActiveProject } from '@/context/AppContext';
import { runSecurityScan, calculateCosts } from '@/lib/analysis';
import { DeploymentStep } from '@/types';
import {
  CheckCircle2, XCircle, Loader2, Play, RotateCcw, Rocket,
  ChevronRight, Terminal, Shield, DollarSign, Zap,
  ThumbsUp, ThumbsDown, AlertTriangle
} from 'lucide-react';
import clsx from 'clsx';

const AWS_STEPS: Omit<DeploymentStep, 'status' | 'output'>[] = [
  { id: 'validate',  label: 'Validate Architecture',  description: 'Check resource configuration and connectivity requirements', provider: 'aws' },
  { id: 'security',  label: 'Security Scan',           description: 'Identify critical security misconfigurations',              provider: 'aws' },
  { id: 'cost',      label: 'Cost Check',              description: 'Estimate and confirm infrastructure costs',                  provider: 'aws' },
  { id: 'plan',      label: 'Terraform Plan',          description: 'Generate and review the Terraform execution plan',           provider: 'aws' },
  { id: 'approval',  label: 'Approval Gate',           description: 'Manual approval required before deployment',                provider: 'aws' },
  { id: 'deploy',    label: 'Deploy',                  description: 'Apply changes to the target cloud environment',              provider: 'aws' },
];

const AZURE_STEPS: Omit<DeploymentStep, 'status' | 'output'>[] = [
  { id: 'az-validate', label: 'Validate (Azure)',     description: 'Validate Azure resource configurations',          provider: 'azure' },
  { id: 'az-plan',     label: 'ARM/Bicep Plan',       description: 'Generate Azure Resource Manager plan',            provider: 'azure' },
  { id: 'az-deploy',   label: 'Deploy (Azure)',       description: 'Apply Azure deployments',                         provider: 'azure' },
];

function buildOutput(id: string, issues: ReturnType<typeof runSecurityScan>, costs: ReturnType<typeof calculateCosts>): string {
  switch (id) {
    case 'validate':    return '✓ All resource configurations validated\n✓ Network topology is valid\n✓ Required fields present';
    case 'security': {
      const critical = issues.filter((i) => i.severity === 'critical');
      if (critical.length > 0) return `✗ ${critical.length} critical issue(s):\n${critical.map((i) => `  - ${i.message}`).join('\n')}\n\n⛔ Deployment blocked.`;
      return issues.length > 0 ? `⚠ ${issues.length} non-critical issue(s)\nProceeding with warnings...` : '✓ No security issues found';
    }
    case 'cost': {
      const total = costs.reduce((a, c) => a + c.monthlyCost, 0);
      return `✓ Estimated monthly cost: $${total.toFixed(2)}\n✓ ${costs.length} billable resources\n✓ Within budget threshold`;
    }
    case 'plan':        return `Terraform will perform the following actions:\n\n  # Plan: ${Math.floor(Math.random() * 5) + 3} to add, 0 to change, 0 to destroy.\n\nPlan: 5 to add, 0 to change, 0 to destroy.`;
    case 'approval':    return 'Awaiting manual approval...';
    case 'deploy':      return `Applying Terraform configuration...\n\naws_vpc.main: Creating...\naws_subnet.public: Creating...\naws_instance.web: Creating...\n\nApply complete! Resources: 5 added, 0 changed, 0 destroyed.\n\n✓ Infrastructure deployed successfully (mock)`;
    case 'az-validate': return '✓ Azure resource configurations valid\n✓ ARM template validated';
    case 'az-plan':     return 'ARM template compiled\n5 resources to create, 0 to update';
    case 'az-deploy':   return 'Deployment initiated...\n✓ All Azure resources deployed (mock)';
    default: return '';
  }
}

interface PipelineProps {
  steps: Omit<DeploymentStep, 'status' | 'output'>[];
  label: string;
  issues: ReturnType<typeof runSecurityScan>;
  costs: ReturnType<typeof calculateCosts>;
  badge?: string;
  badgeColor?: string;
}

function Pipeline({ steps: stepDefs, label, issues, costs, badge, badgeColor }: PipelineProps) {
  const [steps, setSteps] = useState<DeploymentStep[]>(stepDefs.map((s) => ({ ...s, status: 'pending' })));
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  const hasCritical = issues.some((i) => i.severity === 'critical');
  const allDone = steps.every((s) => s.status === 'success');
  const hasFailure = steps.some((s) => s.status === 'failed');
  const pendingApproval = steps.some((s) => s.id === 'approval' && s.status === 'awaiting_approval');

  async function runDeployment() {
    setRunning(true);
    setApproved(false);
    const newSteps = stepDefs.map((s) => ({ ...s, status: 'pending' as const, output: undefined }));
    setSteps(newSteps);

    for (let i = 0; i < stepDefs.length; i++) {
      const step = stepDefs[i];
      setCurrentStep(i);
      setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, status: 'running' } : s));
      await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));

      const output = buildOutput(step.id, issues, costs);
      const shouldFail = step.id === 'security' && hasCritical;

      if (step.id === 'approval') {
        setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, status: 'awaiting_approval', output } : s));
        setExpanded(step.id);
        setRunning(false);
        return;
      }

      setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, status: shouldFail ? 'failed' : 'success', output } : s));
      setExpanded(step.id);
      if (shouldFail) { setRunning(false); setCurrentStep(-1); return; }
    }
    setRunning(false);
    setCurrentStep(-1);
  }

  async function handleApprove() {
    const approvalIdx = steps.findIndex((s) => s.id === 'approval');
    if (approvalIdx === -1) return;
    setApproved(true);
    setSteps((prev) => prev.map((s, idx) => idx === approvalIdx ? { ...s, status: 'success' } : s));
    setRunning(true);
    for (let i = approvalIdx + 1; i < stepDefs.length; i++) {
      const step = stepDefs[i];
      setCurrentStep(i);
      setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, status: 'running' } : s));
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 600));
      const output = buildOutput(step.id, issues, costs);
      setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, status: 'success', output } : s));
      setExpanded(step.id);
    }
    setRunning(false);
    setCurrentStep(-1);
  }

  function reset() {
    setSteps(stepDefs.map((s) => ({ ...s, status: 'pending' })));
    setCurrentStep(-1);
    setExpanded(null);
    setApproved(false);
  }

  return (
    <div className="mb-6">
      {/* Pipeline header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-white font-semibold text-sm">{label}</h3>
          {badge && (
            <span className={clsx('text-[10px] px-2 py-0.5 rounded-full font-medium', badgeColor ?? 'bg-gray-700 text-gray-400')}>
              {badge}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {(hasFailure || allDone) && (
            <button onClick={reset} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
          )}
          {!running && !allDone && !pendingApproval && (
            <button
              onClick={runDeployment}
              aria-label={`Start ${label} deployment`}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <Play className="w-3.5 h-3.5" />
              {hasFailure ? 'Retry' : 'Start'}
            </button>
          )}
          {running && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-900/40 border border-blue-800 text-blue-300 rounded-lg text-xs" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Running...
            </div>
          )}
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-2">
        {steps.map((step, idx) => {
          const isExpanded = expanded === step.id;
          return (
            <div key={step.id} className={clsx('bg-gray-800 border rounded-xl overflow-hidden transition-colors',
              step.status === 'running' ? 'border-blue-700' :
              step.status === 'success' ? 'border-emerald-800/60' :
              step.status === 'failed' ? 'border-red-800' :
              step.status === 'awaiting_approval' ? 'border-yellow-700' :
              'border-gray-700'
            )}>
              <button className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
                onClick={() => step.output && setExpanded(isExpanded ? null : step.id)}>
                <div className={clsx('w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                  step.status === 'pending' ? 'bg-gray-700 text-gray-500' :
                  step.status === 'running' ? 'bg-blue-900 text-blue-300' :
                  step.status === 'success' ? 'bg-emerald-900 text-emerald-400' :
                  step.status === 'awaiting_approval' ? 'bg-yellow-900 text-yellow-400' :
                  'bg-red-900 text-red-400'
                )}>
                  {step.status === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> :
                   step.status === 'success' ? <CheckCircle2 className="w-4 h-4" /> :
                   step.status === 'failed' ? <XCircle className="w-4 h-4" /> :
                   step.status === 'awaiting_approval' ? <AlertTriangle className="w-3.5 h-3.5" /> :
                   idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={clsx('font-medium text-sm', step.status === 'pending' ? 'text-gray-500' : 'text-white')}>{step.label}</p>
                  <p className="text-gray-600 text-xs">{step.description}</p>
                </div>
                {step.provider && (
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded shrink-0', step.provider === 'aws' ? 'bg-orange-900/40 text-orange-400' : 'bg-blue-900/40 text-blue-400')}>
                    {step.provider.toUpperCase()}
                  </span>
                )}
                {step.status !== 'pending' && step.status !== 'running' && step.status !== 'awaiting_approval' && (
                  <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium shrink-0',
                    step.status === 'success' ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'
                  )}>
                    {step.status === 'success' ? 'Passed' : 'Failed'}
                  </span>
                )}
                {step.output && <ChevronRight className={clsx('w-4 h-4 text-gray-600 transition-transform shrink-0', isExpanded && 'rotate-90')} />}
              </button>

              {step.status === 'awaiting_approval' && (
                <div className="px-4 pb-4">
                  <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 flex items-center justify-between">
                    <p className="text-yellow-300 text-xs">Terraform plan reviewed. Approve to proceed with deployment.</p>
                    <div className="flex gap-2">
                      <button onClick={reset} className="flex items-center gap-1 px-2 py-1 bg-red-900 hover:bg-red-800 text-red-300 rounded text-xs">
                        <ThumbsDown className="w-3 h-3" /> Reject
                      </button>
                      <button onClick={handleApprove} className="flex items-center gap-1 px-2 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-xs font-medium">
                        <ThumbsUp className="w-3 h-3" /> Approve
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {isExpanded && step.output && (
                <div className="px-4 pb-4">
                  <div className="bg-gray-950 rounded-lg p-3 flex items-start gap-2">
                    <Terminal className="w-4 h-4 text-gray-600 mt-0.5 shrink-0" />
                    <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">{step.output}</pre>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {allDone && (
        <div className="mt-3 bg-emerald-900/30 border border-emerald-800 rounded-xl p-3 flex items-center gap-3">
          <Zap className="w-4 h-4 text-emerald-400" />
          <p className="text-emerald-300 text-sm font-medium">Pipeline completed successfully (mock)</p>
        </div>
      )}
    </div>
  );
}

export default function DeployPanel() {
  const activeProject = useActiveProject();

  if (!activeProject) return null;

  const issues = runSecurityScan(activeProject.nodes);
  const costs = calculateCosts(activeProject.nodes);
  const isMultiCloud = activeProject.provider === 'multi';

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <Rocket className="w-5 h-5 text-blue-400" />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-white font-bold text-lg">Deployment Center</h2>
              <span className="text-xs px-2 py-0.5 bg-yellow-900/40 text-yellow-300 border border-yellow-800 rounded-full font-medium">Demo Mode</span>
            </div>
            <p className="text-gray-500 text-xs mt-0.5">No real credentials used — mock simulation only</p>
          </div>
        </div>

        {/* Env + target */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-5 flex items-center justify-between">
          <div>
            <p className="text-white font-medium text-sm">Target Environment</p>
            <p className="text-gray-500 text-xs mt-0.5">Mock environment — no real credentials used</p>
          </div>
          <div>
            <label htmlFor="deploy-env" className="sr-only">Target environment</label>
            <select id="deploy-env" className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option>Staging</option>
              <option>Production</option>
              <option>Development</option>
            </select>
          </div>
        </div>

        {/* Pipelines */}
        {isMultiCloud ? (
          <>
            <div className="bg-gray-800/50 border border-orange-900/40 rounded-xl p-4 mb-4">
              <Pipeline
                steps={AWS_STEPS}
                label="AWS Pipeline"
                issues={issues}
                costs={costs}
                badge="Phase 1"
                badgeColor="bg-orange-900/40 text-orange-400"
              />
            </div>
            <div className="bg-gray-800/50 border border-blue-900/40 rounded-xl p-4">
              <Pipeline
                steps={AZURE_STEPS}
                label="Azure Pipeline"
                issues={issues}
                costs={costs}
                badge="Phase 2"
                badgeColor="bg-blue-900/40 text-blue-400"
              />
            </div>
            <p className="text-gray-600 text-xs text-center mt-3">Multi-cloud: AWS deploys first, Azure follows</p>
          </>
        ) : (
          <Pipeline
            steps={activeProject.provider === 'azure' ? AZURE_STEPS : AWS_STEPS}
            label={`${activeProject.provider.toUpperCase()} Pipeline`}
            issues={issues}
            costs={costs}
          />
        )}

        {activeProject.nodes.length === 0 && (
          <div className="mt-4 bg-yellow-900/20 border border-yellow-800 rounded-xl p-4">
            <p className="text-yellow-400 text-sm font-medium">⚠ No resources on canvas</p>
            <p className="text-yellow-700 text-xs mt-1">Add resources to the visual canvas before deploying</p>
          </div>
        )}
      </div>
    </div>
  );
}
