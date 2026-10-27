'use client';
import React, { useState, useEffect, useMemo } from 'react';
import { CanvasNode, CanvasEdge } from '@/types';
import {
  analyzeCanvasIamDependencies,
  applyCompletedIamRolesToCanvas,
  MissingIamRoleRequirement,
} from '@/lib/engines/iam/iamDependencyAnalyzer';
import { ShieldCheck, ShieldAlert, Key, Check, ArrowRight, X, AlertTriangle, Layers, Lock, Cpu, Database, Server, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';

interface IamCompletionModalProps {
  isOpen: boolean;
  onClose: () => void;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onApply: (newNodes: CanvasNode[], newEdges: CanvasEdge[]) => void;
}

export default function IamCompletionModal({
  isOpen,
  onClose,
  nodes,
  edges,
  onApply,
}: IamCompletionModalProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  // Run analysis
  const report = useMemo(() => analyzeCanvasIamDependencies(nodes, edges), [nodes, edges]);

// Form state per requirement
  const [submissions, setSubmissions] = useState<
    Record<
      string,
      {
        roleName: string;
        description: string;
        path: string;
        permissionsBoundary: string;
        createInstanceProfile: boolean;
        createAccessKey: boolean;
        selectedResourceIds: string[];
        selectedTargetIds: string[];
        provider?: 'aws' | 'azure';
        roleType?: 'role' | 'user' | 'managed-identity';
      }
    >
  >({});

  const [customRequirements, setCustomRequirements] = useState<MissingIamRoleRequirement[]>([]);
  const [replaceGeneric, setReplaceGeneric] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('');

  // Combined requirements (detected + custom added)
  const allRequirements = useMemo(() => {
    return [...report.requirements, ...customRequirements];
  }, [report.requirements, customRequirements]);

  // Initialize form state when report changes or modal opens
  useEffect(() => {
    if (!isOpen) return;
    const initial: typeof submissions = {};
    allRequirements.forEach((req) => {
      initial[req.id] = {
        roleName: submissions[req.id]?.roleName || req.suggestedRoleName,
        description: submissions[req.id]?.description || req.description || '',
        path: submissions[req.id]?.path || req.path || '/',
        permissionsBoundary: submissions[req.id]?.permissionsBoundary || req.permissionsBoundary || '',
        createInstanceProfile: submissions[req.id]?.createInstanceProfile ?? (req.createInstanceProfile ?? true),
        createAccessKey: submissions[req.id]?.createAccessKey ?? (req.createAccessKey ?? true),
        selectedResourceIds: submissions[req.id]?.selectedResourceIds || [...req.selectedResourceIds],
        selectedTargetIds: submissions[req.id]?.selectedTargetIds || [...req.selectedTargetIds],
        provider: req.provider || (req.category.startsWith('azure') ? 'azure' : 'aws'),
        roleType: req.roleType || 'role',
      };
    });
    setSubmissions(initial);
    if (allRequirements.length > 0 && !activeTab) {
      setActiveTab(allRequirements[0].id);
    }
  }, [isOpen, allRequirements]);

  if (!isOpen) return null;

  const handleRoleNameChange = (reqId: string, name: string) => {
    setSubmissions((prev) => ({
      ...prev,
      [reqId]: { ...prev[reqId], roleName: name },
    }));
  };

  const handleFieldChange = (reqId: string, field: string, value: any) => {
    setSubmissions((prev) => ({
      ...prev,
      [reqId]: { ...prev[reqId], [field]: value },
    }));
  };

  const handleToggleResource = (reqId: string, resId: string) => {
    setSubmissions((prev) => {
      const current = prev[reqId]?.selectedResourceIds || [];
      const updated = current.includes(resId) ? current.filter((id) => id !== resId) : [...current, resId];
      return {
        ...prev,
        [reqId]: { ...prev[reqId], selectedResourceIds: updated },
      };
    });
  };

  const handleToggleTarget = (reqId: string, targetId: string) => {
    setSubmissions((prev) => {
      const current = prev[reqId]?.selectedTargetIds || [];
      const updated = current.includes(targetId) ? current.filter((id) => id !== targetId) : [...current, targetId];
      return {
        ...prev,
        [reqId]: { ...prev[reqId], selectedTargetIds: updated },
      };
    });
  };

  const handleAddIdentityUser = () => {
    const isAzure = report.detectedProvider === 'azure';
    const userId = isAzure ? `custom-entra-user-${Date.now()}` : `custom-iam-user-${Date.now()}`;
    const newReq: MissingIamRoleRequirement = isAzure
      ? {
          id: userId,
          category: 'azure-role-assignment',
          title: 'Microsoft Entra ID User',
          suggestedRoleName: 'admin@company.onmicrosoft.com',
          servicePrincipal: 'Microsoft Entra ID',
          mandatory: false,
          provider: 'azure',
          roleType: 'user',
          description: 'Enterprise directory user with Azure RBAC assignments',
          reason: 'Enterprise directory user with Azure RBAC assignments to access resources.',
          designatedResources: [],
          selectedResourceIds: [],
          targetPermissions: nodes
            .filter((n) => n.resourceType.includes('key_vault') || n.resourceType.includes('storage'))
            .map((t) => ({
              resourceId: t.id,
              resourceLabel: t.label,
              resourceType: t.resourceType,
              permissionAction: 'Key Vault Secrets Officer / Blob Contributor',
              edgeLabel: 'RBAC Assignment',
              description: 'Assign role permissions',
            })),
          selectedTargetIds: [],
        }
      : {
          id: userId,
          category: 'iam-user-access',
          title: 'AWS IAM User',
          suggestedRoleName: 'developer-deployer-user',
          servicePrincipal: 'AWS IAM User',
          mandatory: false,
          provider: 'aws',
          roleType: 'user',
          description: 'Dedicated IAM User for CI/CD deployer pipeline or administrator',
          reason: 'Dedicated IAM User with access keys to connect to services or assume roles.',
          path: '/engineering/',
          createAccessKey: true,
          designatedResources: [],
          selectedResourceIds: [],
          targetPermissions: nodes
            .filter((n) => n.resourceType.includes('s3') || n.resourceType.includes('ec2'))
            .map((t) => ({
              resourceId: t.id,
              resourceLabel: t.label,
              resourceType: t.resourceType,
              permissionAction: 's3:PutObject / ec2:DescribeInstances',
              edgeLabel: 'Direct API Access',
              description: 'Programmatic deployment access',
            })),
          selectedTargetIds: [],
        };

    setCustomRequirements((prev) => [...prev, newReq]);
    setActiveTab(userId);
  };

  const handleApply = () => {
    const { nodes: newNodes, edges: newEdges } = applyCompletedIamRolesToCanvas(
      nodes,
      edges,
      submissions,
      replaceGeneric && report.hasGenericPlaceholder
    );
    onApply(newNodes, newEdges);
    onClose();
  };

  const activeReq = allRequirements.find((r) => r.id === activeTab) || allRequirements[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200"
      id="iam-completion-modal"
    >
      <div
        className={clsx(
          'border rounded-2xl max-w-4xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden',
          isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-[#18181a] border-white/10 text-slate-100'
        )}
      >
        {/* Header */}
        <div
          className={clsx(
            'px-6 py-4 border-b flex items-center justify-between shrink-0',
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900/60 border-white/10'
          )}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-500 shrink-0">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-tight">
                  Publish Readiness: Mandatory IAM Roles & Connections
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/15 text-purple-400 border border-purple-500/30 uppercase tracking-wider">
                  Least-Privilege Gate
                </span>
              </div>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
                Define required IAM roles and auto-wire directional permission edges on your canvas before publishing.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className={clsx(
              'p-2 rounded-lg transition-colors',
              isLight ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-200' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            )}
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Status Alert Banner */}
        <div
          className={clsx(
            'px-6 py-3 border-b flex items-center justify-between text-xs font-medium',
            report.hasMissingRequirements
              ? isLight
                ? 'bg-amber-50 border-amber-200 text-amber-900'
                : 'bg-amber-950/40 border-amber-500/30 text-amber-200'
              : isLight
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200'
          )}
        >
          <div className="flex items-center gap-2">
            {report.hasMissingRequirements ? (
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            )}
            <span>
              {report.hasMissingRequirements
                ? `${report.totalMissing} mandatory IAM role dependency requirements detected in this architecture.`
                : 'All resources are properly assigned to least-privilege IAM roles with valid canvas edges.'}
            </span>
          </div>

          {report.hasGenericPlaceholder && (
            <label className="flex items-center gap-1.5 cursor-pointer ml-3">
              <input
                type="checkbox"
                checked={replaceGeneric}
                onChange={(e) => setReplaceGeneric(e.target.checked)}
                className="rounded border-slate-400 text-purple-600 focus:ring-purple-500 w-3.5 h-3.5"
              />
              <span className="text-[11px] font-semibold text-purple-600 dark:text-purple-300">
                Replace generic &apos;AWS IAM&apos; node with these roles
              </span>
            </label>
          )}
        </div>

        {/* Content Body: Sidebar Navigation & Role Form */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Tab List */}
          <div
            className={clsx(
              'w-64 border-r shrink-0 overflow-y-auto p-3 space-y-1.5',
              isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900/40 border-white/10'
            )}
          >
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Identity Roles ({allRequirements.length})
              </span>
              <button
                type="button"
                onClick={handleAddIdentityUser}
                className="text-[10px] font-bold text-purple-600 dark:text-purple-400 hover:underline flex items-center gap-1"
                title="Add a new IAM User or Entra ID User"
              >
                + Add {report.detectedProvider === 'azure' ? 'User' : 'IAM User'}
              </button>
            </div>

            {allRequirements.map((req) => {
              const isSelected = req.id === activeTab;
              const sub = submissions[req.id];
              const isConfigured = sub && sub.roleName.trim() !== '';

              return (
                <button
                  key={req.id}
                  type="button"
                  onClick={() => setActiveTab(req.id)}
                  className={clsx(
                    'w-full text-left px-3 py-2.5 rounded-xl border text-xs font-medium transition-all flex items-start justify-between gap-2',
                    isSelected
                      ? isLight
                        ? 'bg-purple-50 border-purple-300 text-purple-950 font-semibold shadow-xs'
                        : 'bg-purple-950/50 border-purple-500/50 text-purple-200 font-semibold shadow-xs'
                      : isLight
                      ? 'border-slate-200 hover:bg-slate-100 text-slate-700'
                      : 'border-white/5 hover:bg-slate-800 text-slate-300'
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate flex items-center gap-1.5">
                      <span>{req.title}</span>
                      {req.roleType === 'user' && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] bg-blue-500/20 text-blue-400 font-mono">USER</span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate mt-0.5">
                      {sub?.roleName || req.suggestedRoleName}
                    </div>
                  </div>

                  {isConfigured ? (
                    <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 mt-1" title="Configured" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0 mt-1" title="Needs input" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Right Role Detail Form */}
          {activeReq ? (
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Role Header Info */}
              <div
                className={clsx(
                  'p-4 rounded-xl border space-y-2',
                  isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900/60 border-white/10'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">{activeReq.title}</span>
                    <span className={clsx(
                      'px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
                      activeReq.provider === 'azure' ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    )}>
                      {activeReq.provider === 'azure' ? 'Azure RBAC' : 'AWS IAM'}
                    </span>
                    {activeReq.mandatory && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-500 border border-rose-500/30 uppercase">
                        Mandatory
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    Principal: {activeReq.servicePrincipal}
                  </div>
                </div>
                <p className={clsx('text-xs leading-relaxed', isLight ? 'text-slate-600' : 'text-slate-400')}>
                  {activeReq.reason}
                </p>
              </div>

              {/* Mandatory Field: Name */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold">
                    {activeReq.roleType === 'user' ? 'User Name / Email' : 'Role / Identity Name'} <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={submissions[activeReq.id]?.roleName || ''}
                    onChange={(e) => handleRoleNameChange(activeReq.id, e.target.value)}
                    placeholder={activeReq.suggestedRoleName}
                    className={clsx(
                      'w-full px-3.5 py-2 rounded-xl text-xs font-mono border focus:outline-none focus:ring-2 focus:ring-purple-500/40',
                      isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-white'
                    )}
                  />
                  <span className="text-[10px] text-slate-400">
                    Resource identifier declared in generated Terraform & IAM policies.
                  </span>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-bold">
                    Description & Purpose
                  </label>
                  <input
                    type="text"
                    value={submissions[activeReq.id]?.description || ''}
                    onChange={(e) => handleFieldChange(activeReq.id, 'description', e.target.value)}
                    placeholder={activeReq.description || 'Purpose of this role'}
                    className={clsx(
                      'w-full px-3.5 py-2 rounded-xl text-xs border focus:outline-none focus:ring-2 focus:ring-purple-500/40',
                      isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-white'
                    )}
                  />
                  <span className="text-[10px] text-slate-400">
                    Compliance documentation for auditing & security reviews.
                  </span>
                </div>
              </div>

              {/* Scoping Fields: Path & Permissions Boundary */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold">
                    IAM Path
                  </label>
                  <input
                    type="text"
                    value={submissions[activeReq.id]?.path || '/'}
                    onChange={(e) => handleFieldChange(activeReq.id, 'path', e.target.value)}
                    placeholder="/ or /service-roles/"
                    className={clsx(
                      'w-full px-3.5 py-2 rounded-xl text-xs font-mono border focus:outline-none focus:ring-2 focus:ring-purple-500/40',
                      isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-white'
                    )}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-bold">
                    Permissions Boundary ARN
                  </label>
                  <input
                    type="text"
                    value={submissions[activeReq.id]?.permissionsBoundary || ''}
                    onChange={(e) => handleFieldChange(activeReq.id, 'permissionsBoundary', e.target.value)}
                    placeholder="arn:aws:iam::123456789012:policy/Boundary"
                    className={clsx(
                      'w-full px-3.5 py-2 rounded-xl text-xs font-mono border focus:outline-none focus:ring-2 focus:ring-purple-500/40',
                      isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-white'
                    )}
                  />
                </div>
              </div>

              {/* Flags: Instance Profile / Access Key */}
              <div className="flex flex-wrap items-center gap-6 p-3 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-slate-900/30 text-xs">
                {activeReq.category === 'compute-instance-profile' && (
                  <label className="flex items-center gap-2 cursor-pointer font-medium">
                    <input
                      type="checkbox"
                      checked={submissions[activeReq.id]?.createInstanceProfile ?? true}
                      onChange={(e) => handleFieldChange(activeReq.id, 'createInstanceProfile', e.target.checked)}
                      className="rounded border-slate-400 text-purple-600 focus:ring-purple-500 w-4 h-4"
                    />
                    <span>Create EC2 Instance Profile (<code>aws_iam_instance_profile</code>)</span>
                  </label>
                )}

                {activeReq.roleType === 'user' && (
                  <label className="flex items-center gap-2 cursor-pointer font-medium">
                    <input
                      type="checkbox"
                      checked={submissions[activeReq.id]?.createAccessKey ?? true}
                      onChange={(e) => handleFieldChange(activeReq.id, 'createAccessKey', e.target.checked)}
                      className="rounded border-slate-400 text-purple-600 focus:ring-purple-500 w-4 h-4"
                    />
                    <span>Generate Programmatic Access Key & Secret (<code>aws_iam_access_key</code>)</span>
                  </label>
                )}
              </div>

              {/* Mandatory Designated Resources Attachment */}
              <div className="space-y-2">
                <label className="block text-xs font-bold">
                  Attach Role To Canvas Resources ({activeReq.designatedResources.length} matching) <span className="text-rose-500">*</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {activeReq.designatedResources.map((res) => {
                    const isChecked = submissions[activeReq.id]?.selectedResourceIds.includes(res.id);
                    return (
                      <button
                        key={res.id}
                        type="button"
                        onClick={() => handleToggleResource(activeReq.id, res.id)}
                        className={clsx(
                          'p-3 rounded-xl border text-left flex items-start gap-2.5 transition-all',
                          isChecked
                            ? isLight
                              ? 'bg-purple-50/80 border-purple-300 text-purple-950 font-semibold'
                              : 'bg-purple-950/40 border-purple-500/50 text-purple-200 font-semibold'
                            : isLight
                            ? 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                            : 'bg-slate-950/60 border-white/5 text-slate-400 hover:bg-slate-900'
                        )}
                      >
                        <div
                          className={clsx(
                            'w-4 h-4 rounded mt-0.5 border flex items-center justify-center shrink-0',
                            isChecked ? 'bg-purple-600 border-purple-600 text-white' : 'border-slate-400'
                          )}
                        >
                          {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs truncate">{res.label}</div>
                          <div className="text-[10px] font-normal text-slate-400 truncate mt-0.5">
                            ID: {res.id} • {res.description || res.resourceType}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Target Permissions / Allowed Resources */}
              {activeReq.targetPermissions.length > 0 && (
                <div className="space-y-2">
                  <label className="block text-xs font-bold">
                    Target Resource Permissions ({activeReq.targetPermissions.length} accessible services)
                  </label>
                  <div className="space-y-2">
                    {activeReq.targetPermissions.map((target) => {
                      const isChecked = submissions[activeReq.id]?.selectedTargetIds.includes(target.resourceId);
                      return (
                        <div
                          key={target.resourceId}
                          onClick={() => handleToggleTarget(activeReq.id, target.resourceId)}
                          className={clsx(
                            'p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition-all',
                            isChecked
                              ? isLight
                                ? 'bg-blue-50/70 border-blue-200 text-blue-950'
                                : 'bg-blue-950/30 border-blue-500/40 text-blue-200'
                              : isLight
                              ? 'bg-white border-slate-200 text-slate-600 opacity-60'
                              : 'bg-slate-950/60 border-white/5 text-slate-400 opacity-60'
                          )}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div
                              className={clsx(
                                'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                                isChecked ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-400'
                              )}
                            >
                              {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                            </div>
                            <div className="min-w-0">
                              <span className="text-xs font-semibold">{target.resourceLabel}</span>
                              <p className="text-[10px] text-slate-400 truncate mt-0.5">{target.description}</p>
                            </div>
                          </div>

                          <div className="shrink-0 flex items-center gap-1.5 font-mono text-[10px] px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300">
                            <ArrowRight className="w-3 h-3" />
                            <span>{target.permissionAction}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8 text-center text-slate-400">
              Select an IAM role from the left menu to view and configure its attachments.
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          className={clsx(
            'px-6 py-4 border-t flex items-center justify-between shrink-0',
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900/60 border-white/10'
          )}
        >
          <div className="text-xs text-slate-500">
            Applying will inject discrete IAM Role nodes and draw directional permission lines on your canvas.
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className={clsx(
                'px-4 py-2 rounded-xl text-xs font-semibold border transition-colors',
                isLight ? 'border-slate-300 hover:bg-slate-100 text-slate-700' : 'border-slate-700 hover:bg-slate-800 text-slate-300'
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              id="btn-apply-iam-roles"
              onClick={handleApply}
              className="px-5 py-2 rounded-xl text-xs font-bold bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white shadow-md transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Key className="w-3.5 h-3.5" />
              <span>Apply & Connect on Canvas</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
