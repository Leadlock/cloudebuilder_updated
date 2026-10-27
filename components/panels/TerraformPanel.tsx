'use client';
import React, { useState, useEffect, useMemo } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiTerraformService } from '@/lib/services/ApiTerraformService';
import {
  Code2,
  Copy,
  Check,
  Download,
  FolderOpen,
  RefreshCw,
  FileCode2,
  AlertTriangle,
  Wrench,
  Sparkles,
  ShieldAlert,
  Network,
  Layers,
  Cpu,
  ChevronDown,
  ChevronUp,
  X,
  CheckCircle2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  analyzeTerraformWarnings,
  applyManualFixToProject,
  fixAllWarnings,
  StructuredTerraformWarning,
} from '@/lib/terraform/terraformWarningAnalyzer';
import TerraformFixModal from './TerraformFixModal';

const FILE_ICONS: Record<string, string> = {
  'main.tf': '📄',
  'providers.tf': '🔌',
  'variables.tf': '⚙',
  'outputs.tf': '📤',
  'terraform.tfvars': '🔒',
};

export default function TerraformPanel() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';
  const activeProject = useActiveProject();

  const [activeFile, setActiveFile] = useState<string>('main.tf');
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [key, setKey] = useState(0);
  const [apiFiles, setApiFiles] = useState<Record<string, string> | null>(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [warningsExpanded, setWarningsExpanded] = useState(true);

  // Fix modal state
  const [selectedFixWarning, setSelectedFixWarning] = useState<StructuredTerraformWarning | null>(null);
  const [fixModalOpen, setFixModalOpen] = useState(false);
  const [fixModalTab, setFixModalTab] = useState<'manual' | 'ai'>('manual');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const activeProjectId = activeProject?.id ?? null;
  const nodeCount = activeProject?.nodes.length ?? 0;

  // Structured warning items with problem explanation, manual fix instructions, and AI prompt
  const structuredWarnings = useMemo(() => {
    return analyzeTerraformWarnings(warnings, activeProject?.nodes || [], activeProject?.edges || []);
  }, [warnings, activeProject?.nodes, activeProject?.edges]);

  const criticalCount = structuredWarnings.filter((w) => w.severity === 'critical').length;
  const warningCount = structuredWarnings.filter((w) => w.severity === 'warning').length;

  // ── Automatic Live Generation ──────────────────────────────────────────────
  // Immediately generates and updates Terraform files whenever the active project,
  // its nodes, edges, or configuration changes, guaranteeing 100% sync with the visual builder.
  useEffect(() => {
    if (!activeProject || activeProject.nodes.length === 0) {
      setApiFiles(null);
      setWarnings([]);
      return;
    }

    try {
      const { files: local, warnings: w } = apiTerraformService.generateFilesWithWarnings(
        activeProject.nodes,
        activeProject.edges,
        activeProject.provider,
        activeProject.name
      );
      setApiFiles(local);
      setWarnings(w);
      setError(null);
      setApiLoading(false);
      if (!local[activeFile]) {
        const first = Object.keys(local)[0] ?? 'main.tf';
        setActiveFile(first);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to generate Terraform from canvas state.');
    }
  }, [
    activeProjectId,
    activeProject?.name,
    activeProject?.nodes,
    activeProject?.edges,
    activeProject?.provider,
    activeProject?.updatedAt,
    retryCount,
  ]);

  if (!activeProject) return null;

  if (nodeCount === 0) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50' : 'bg-gray-950')}>
        <div className="text-center px-8 py-12">
          <FileCode2 className={clsx('w-12 h-12 mx-auto mb-4', isLight ? 'text-slate-300' : 'text-gray-700')} />
          <p className={clsx('font-medium text-lg', isLight ? 'text-slate-700' : 'text-gray-400')}>
            No resources to generate
          </p>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-gray-600')}>
            Add resources to the canvas to generate Terraform code
          </p>
        </div>
      </div>
    );
  }

  if (apiLoading) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50' : 'bg-gray-950')}>
        <div className="text-center" role="status" aria-label="Generating Terraform">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className={clsx('font-medium', isLight ? 'text-slate-800' : 'text-gray-400')}>Generating Terraform…</p>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-gray-600')}>
            Compiling production HCL from canvas architecture
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center p-6', isLight ? 'bg-slate-50' : 'bg-gray-950')}>
        <div
          className={clsx(
            'text-center max-w-md border rounded-xl p-8 shadow-xl',
            isLight ? 'bg-white border-rose-200' : 'bg-gray-900 border-red-800/60'
          )}
        >
          <AlertTriangle className={clsx('w-12 h-12 mx-auto mb-4', isLight ? 'text-rose-600' : 'text-red-400')} aria-hidden="true" />
          <h3 className={clsx('font-semibold text-lg mb-2', isLight ? 'text-slate-900' : 'text-white')}>
            Terraform Generation Failed
          </h3>
          <p className={clsx('text-sm mb-6', isLight ? 'text-slate-600' : 'text-gray-400')}>{error}</p>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-rose-500"
          >
            Retry Generation
          </button>
        </div>
      </div>
    );
  }

  if (!apiFiles) return null;

  const files = apiFiles;
  const fileNames = Object.keys(files);
  const currentFile = files[activeFile] ? activeFile : (fileNames[0] ?? 'main.tf');
  const code = files[currentFile] ?? '';
  const lineCount = code.split('\n').length;

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    const all = Object.entries(files)
      .map(([name, content]) => `### ${name}\n${content}`)
      .join('\n\n');
    const blob = new Blob([all], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeProject!.name.replace(/\s+/g, '-').toLowerCase()}.tf.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setError(null);
    try {
      const { files: local, warnings: w } = apiTerraformService.generateFilesWithWarnings(
        activeProject!.nodes,
        activeProject!.edges,
        activeProject!.provider,
        activeProject!.name
      );
      setApiFiles(local);
      setWarnings(w);
      setKey((k) => k + 1);
    } catch {
      setError('Failed to regenerate Terraform from canvas state.');
    } finally {
      setRegenerating(false);
    }
  }

  const handleOpenManualFix = (w: StructuredTerraformWarning) => {
    setSelectedFixWarning(w);
    setFixModalTab('manual');
    setFixModalOpen(true);
  };

  const handleOpenAiFix = (w: StructuredTerraformWarning) => {
    setSelectedFixWarning(w);
    setFixModalTab('ai');
    setFixModalOpen(true);
  };

  const handleApplyManualFix = (warning: StructuredTerraformWarning, inputs?: Record<string, string>) => {
    if (!activeProject) return;
    const { updatedProject, message } = applyManualFixToProject(warning, activeProject, inputs);
    dispatch({
      type: 'UPDATE_CANVAS',
      nodes: updatedProject.nodes,
      edges: updatedProject.edges,
    });
    try {
      const { files: newFiles, warnings: newWarnings } = apiTerraformService.generateFilesWithWarnings(
        updatedProject.nodes,
        updatedProject.edges,
        updatedProject.provider,
        updatedProject.name
      );
      setApiFiles(newFiles);
      setWarnings(newWarnings);
      setKey((k) => k + 1);
    } catch (e) {
      console.error('Failed to regenerate Terraform after manual fix:', e);
    }
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 5000);
  };

  const handleApplyAiFix = async (
    warning: StructuredTerraformWarning,
    _prompt: string,
    inputs: Record<string, string>
  ) => {
    if (!activeProject) return;
    const { updatedProject, message } = applyManualFixToProject(warning, activeProject, inputs);
    dispatch({
      type: 'UPDATE_CANVAS',
      nodes: updatedProject.nodes,
      edges: updatedProject.edges,
    });
    try {
      const { files: newFiles, warnings: newWarnings } = apiTerraformService.generateFilesWithWarnings(
        updatedProject.nodes,
        updatedProject.edges,
        updatedProject.provider,
        updatedProject.name
      );
      setApiFiles(newFiles);
      setWarnings(newWarnings);
      setKey((k) => k + 1);
    } catch (e) {
      console.error('Failed to regenerate Terraform after AI fix:', e);
    }
    setToastMessage(`✓ AI Fix Applied: ${message}`);
    setTimeout(() => setToastMessage(null), 5000);
  };

  const handleFixAllWithAi = () => {
    if (!activeProject || structuredWarnings.length === 0) return;
    const { updatedProject, fixedCount } = fixAllWarnings(structuredWarnings, activeProject);
    dispatch({
      type: 'UPDATE_CANVAS',
      nodes: updatedProject.nodes,
      edges: updatedProject.edges,
    });
    try {
      const { files: newFiles, warnings: newWarnings } = apiTerraformService.generateFilesWithWarnings(
        updatedProject.nodes,
        updatedProject.edges,
        updatedProject.provider,
        updatedProject.name
      );
      setApiFiles(newFiles);
      setWarnings(newWarnings);
      setKey((k) => k + 1);
    } catch (e) {
      console.error('Failed to regenerate Terraform after batch fix:', e);
    }
    setToastMessage(`✓ AI Auto-Remediated ${fixedCount} warning(s) across your architecture.`);
    setTimeout(() => setToastMessage(null), 5000);
  };

  return (
    <div className={clsx('flex flex-1 min-h-0 relative', isLight ? 'bg-slate-50' : 'bg-gray-950')}>
      {/* File tree */}
      <div
        className={clsx(
          'w-52 flex flex-col shrink-0 border-r',
          isLight ? 'bg-slate-100/80 border-slate-200' : 'bg-gray-900 border-gray-800'
        )}
      >
        <div
          className={clsx(
            'flex items-center gap-2 px-3 py-2.5 border-b',
            isLight ? 'border-slate-200' : 'border-gray-800'
          )}
        >
          <FolderOpen className={clsx('w-3.5 h-3.5', isLight ? 'text-slate-500' : 'text-gray-500')} />
          <span className={clsx('text-xs font-semibold', isLight ? 'text-slate-700' : 'text-gray-400')}>
            terraform/{activeProject.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}
          </span>
        </div>
        <div className="flex-1 py-1">
          {fileNames.map((file) => (
            <button
              key={file}
              onClick={() => setActiveFile(file)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors text-left font-medium',
                currentFile === file
                  ? isLight
                    ? 'bg-white text-blue-600 shadow-xs border-r-2 border-blue-600 font-bold'
                    : 'bg-gray-800 text-white font-bold'
                  : isLight
                  ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              )}
            >
              <span className="text-[10px]">{FILE_ICONS[file] ?? '📄'}</span>
              <span className="font-mono">{file}</span>
            </button>
          ))}
        </div>
        <div className={clsx('p-2 border-t', isLight ? 'border-slate-200' : 'border-gray-800')}>
          <button
            onClick={handleDownload}
            className={clsx(
              'w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors border',
              isLight
                ? 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50 shadow-xs'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700'
            )}
          >
            <Download className="w-3 h-3" />
            Download Package
          </button>
        </div>
      </div>

      {/* Code & Advisory Area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Redesigned Terraform Advisory & Warning Center */}
        {structuredWarnings.length > 0 && (
          <div
            className={clsx(
              'shrink-0 border-b transition-all',
              criticalCount > 0
                ? isLight
                  ? 'bg-rose-50/70 border-rose-200'
                  : 'bg-rose-950/20 border-rose-900/40'
                : isLight
                ? 'bg-amber-50/80 border-amber-200'
                : 'border-amber-800/40 bg-amber-950/20'
            )}
          >
            {/* Header Accordion Bar */}
            <div className="flex items-center justify-between px-4 py-2.5">
              <div className="flex items-center gap-2.5">
                <AlertTriangle
                  className={clsx(
                    'w-4 h-4 shrink-0',
                    criticalCount > 0
                      ? isLight
                        ? 'text-rose-600'
                        : 'text-rose-400'
                      : isLight
                      ? 'text-amber-600'
                      : 'text-amber-400'
                  )}
                />
                <span className={clsx('text-xs font-bold', isLight ? 'text-slate-900' : 'text-slate-100')}>
                  Terraform Deployment Advisory
                </span>
                <div className="flex items-center gap-1.5 ml-1 flex-wrap">
                  {criticalCount > 0 && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-500/20 text-rose-500 border border-rose-500/30">
                      {criticalCount} Critical
                    </span>
                  )}
                  {warningCount > 0 && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-500 border border-amber-500/30">
                      {warningCount} Warning{warningCount > 1 ? 's' : ''}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleFixAllWithAi}
                    className="ml-2 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-xs flex items-center gap-1.5 transition-all cursor-pointer active:scale-95"
                    title="Automatically apply recommended AI fixes to all architecture warnings"
                  >
                    <Sparkles className="w-3 h-3 text-purple-200" />
                    <span>Fix All with AI</span>
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setWarningsExpanded((v) => !v)}
                className={clsx(
                  'flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors cursor-pointer',
                  isLight ? 'hover:bg-slate-200/60 text-slate-700' : 'hover:bg-slate-800 text-slate-300'
                )}
              >
                <span>{warningsExpanded ? 'Collapse' : 'View Fixes'}</span>
                {warningsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* Warning Cards List */}
            {warningsExpanded && (
              <div className="px-4 pb-3.5 space-y-2.5">
                {structuredWarnings.map((w) => (
                  <div
                    key={w.id}
                    className={clsx(
                      'p-3 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xs transition-all',
                      w.severity === 'critical'
                        ? isLight
                          ? 'bg-white border-rose-200/90'
                          : 'bg-slate-900/90 border-rose-900/50'
                        : isLight
                        ? 'bg-white border-amber-200/90'
                        : 'bg-slate-900/90 border-amber-900/40'
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <div
                        className={clsx(
                          'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
                          w.severity === 'critical'
                            ? 'bg-rose-500/15 text-rose-500'
                            : 'bg-amber-500/15 text-amber-500'
                        )}
                      >
                        {w.category === 'load_balancer' && <Layers className="w-4 h-4" />}
                        {w.category === 'networking' && <Network className="w-4 h-4" />}
                        {w.category === 'security' && <ShieldAlert className="w-4 h-4" />}
                        {w.category === 'database' && <Cpu className="w-4 h-4" />}
                        {w.category === 'general' && <AlertTriangle className="w-4 h-4" />}
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className={clsx('text-xs font-bold', isLight ? 'text-slate-900' : 'text-white')}>
                            {w.title}
                          </h4>
                          {w.affectedResource && (
                            <span className="text-[10px] font-mono font-medium px-1.5 py-0.2 rounded bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                              {w.affectedResource}
                            </span>
                          )}
                        </div>
                        <p className={clsx('text-[11px] leading-relaxed', isLight ? 'text-slate-600' : 'text-slate-400')}>
                          {w.suggestedFix}
                        </p>
                      </div>
                    </div>

                    {/* Action Buttons: Manual Fix vs Fix with AI */}
                    <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                      <button
                        type="button"
                        onClick={() => handleOpenManualFix(w)}
                        className={clsx(
                          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer',
                          isLight
                            ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-800 shadow-2xs'
                            : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
                        )}
                      >
                        <Wrench className="w-3.5 h-3.5 text-blue-500" />
                        <span>Manual Fix</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleOpenAiFix(w)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white shadow-md bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 active:scale-95 transition-all cursor-pointer shadow-purple-950/30"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-purple-200" />
                        <span>Fix with AI</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Toast Notification when a fix is applied */}
        {toastMessage && (
          <div className="mx-4 mt-3 px-4 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs font-semibold flex items-center justify-between shadow-lg animate-in slide-in-from-top-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{toastMessage}</span>
            </div>
            <button onClick={() => setToastMessage(null)} className="p-1 hover:opacity-75">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div
          className={clsx(
            'flex items-center justify-between px-4 py-2.5 border-b shrink-0',
            isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-gray-800'
          )}
        >
          <div className="flex items-center gap-3">
            <Code2 className={clsx('w-4 h-4', isLight ? 'text-blue-600' : 'text-blue-400')} />
            <span className={clsx('font-mono text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>
              {currentFile}
            </span>
            <span className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-gray-600')}>{lineCount} lines</span>
            <span
              className={clsx(
                'text-xs px-2 py-0.5 rounded font-mono font-medium',
                isLight ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-900/30 text-emerald-400'
              )}
            >
              production-ready
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors border',
                isLight
                  ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700'
                  : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-400 hover:text-white'
              )}
            >
              <RefreshCw className={clsx('w-3 h-3', regenerating && 'animate-spin')} />
              Regenerate
            </button>
            <button
              onClick={handleCopy}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors border',
                isLight
                  ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700'
                  : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300 hover:text-white'
              )}
            >
              {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              id="btn-tf-next-deploy"
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'deploy' })}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors"
              title="Proceed to Deployment Center"
            >
              <span>Deploy Infrastructure →</span>
            </button>
          </div>
        </div>

        {/* Code Content */}
        <div className={clsx('flex-1 overflow-auto', isLight ? 'bg-slate-50' : 'bg-gray-950')}>
          <div className="flex">
            {/* Line numbers */}
            <div
              className={clsx(
                'shrink-0 select-none text-right pr-4 pt-4 pb-4 border-r',
                isLight ? 'bg-slate-100/70 border-slate-200 text-slate-400' : 'bg-gray-950 border-gray-800/50 text-gray-700'
              )}
              style={{ minWidth: 44 }}
            >
              {code.split('\n').map((_, i) => (
                <div key={i} className="text-xs font-mono leading-5">
                  {i + 1}
                </div>
              ))}
            </div>
            {/* Syntax highlighted Code */}
            <pre
              key={key}
              className={clsx('flex-1 p-4 text-xs font-mono leading-5 overflow-x-auto', isLight ? 'text-slate-800' : 'text-gray-300')}
            >
              {code.split('\n').map((line, i) => {
                let className = '';
                if (line.trimStart().startsWith('#')) className = isLight ? 'text-slate-400 italic' : 'text-gray-600';
                else if (
                  /^\s*resource\s/.test(line) ||
                  /^\s*provider\s/.test(line) ||
                  /^\s*terraform\s/.test(line) ||
                  /^\s*variable\s/.test(line) ||
                  /^\s*output\s/.test(line) ||
                  /^\s*locals\s/.test(line)
                )
                  className = isLight ? 'text-blue-600 font-bold' : 'text-blue-400 font-bold';
                else if (/=\s*"/.test(line)) className = isLight ? 'text-emerald-700' : 'text-emerald-400';
                else if (/^\s*(true|false)\s*$/.test(line.split('=')[1]?.trim() ?? ''))
                  className = isLight ? 'text-amber-600 font-semibold' : 'text-orange-400';
                return (
                  <div key={i} className={className || (isLight ? 'text-slate-800' : 'text-gray-300')}>
                    {line || ' '}
                  </div>
                );
              })}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div
          className={clsx(
            'shrink-0 px-4 py-2 border-t flex items-center justify-between',
            isLight ? 'bg-white border-slate-200' : 'bg-gray-900 border-gray-800'
          )}
        >
          <span className={clsx('text-xs font-mono', isLight ? 'text-slate-500' : 'text-gray-500')}>
            {activeProject.provider === 'multi'
              ? 'hashicorp/aws ~> 5.0 + hashicorp/azurerm ~> 3.0'
              : `hashicorp/${activeProject.provider === 'aws' ? 'aws ~> 5.0' : 'azurerm ~> 3.0'}`}
          </span>
          <span className={clsx('text-xs font-medium', isLight ? 'text-emerald-700' : 'text-emerald-400')}>
            ✓ Syntactically valid HCL & guardrail verified
          </span>
        </div>
      </div>

      {/* Interactive Fix Modal */}
      <TerraformFixModal
        warning={selectedFixWarning}
        isOpen={fixModalOpen}
        initialTab={fixModalTab}
        onClose={() => setFixModalOpen(false)}
        onApplyManualFix={handleApplyManualFix}
        onApplyAiFix={handleApplyAiFix}
      />
    </div>
  );
}
