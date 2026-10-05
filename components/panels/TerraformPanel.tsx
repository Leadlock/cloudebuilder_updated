'use client';
import { useState, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiTerraformService } from '@/lib/services/ApiTerraformService';
import { Code2, Copy, Check, Download, FolderOpen, RefreshCw, FileCode2, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

const FILE_ICONS: Record<string, string> = {
  'main.tf': '📄',
  'providers.tf': '🔌',
  'variables.tf': '⚙',
  'outputs.tf': '📤',
  'terraform.tfvars': '🔒',
};

export default function TerraformPanel() {
  const { state } = useApp();
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
  const [warningsExpanded, setWarningsExpanded] = useState(false);

  const activeProjectId = activeProject?.id ?? null;
  const nodeCount = activeProject?.nodes.length ?? 0;
  const edgeCount = activeProject?.edges.length ?? 0;
  const provider = activeProject?.provider;
  const architectureVersion = state.architectureVersion;
  const updatedAt = activeProject?.updatedAt;

  useEffect(() => {
    if (!activeProjectId || nodeCount === 0 || !activeProject) {
      setApiFiles(null);
      return;
    }
    let cancelled = false;

    // For unsaved draft projects, directly generate from live canvas state
    if (activeProjectId === 'draft-project') {
      try {
        const { files: local, warnings: w } = apiTerraformService.generateFilesWithWarnings(
          activeProject.nodes,
          activeProject.edges,
          activeProject.provider,
        );
        setApiFiles(local);
        setWarnings(w);
        setError(null);
        setApiLoading(false);
        if (!local[activeFile]) {
          const first = Object.keys(local)[0] ?? 'main.tf';
          setActiveFile(first);
        }
      } catch (e) {
        setError('Failed to generate Terraform from live canvas state.');
      }
      return;
    }

    setApiLoading(true);
    apiTerraformService.generateFilesFromApiWithWarnings().then(({ files: result, warnings: w }) => {
      if (!cancelled) {
        setApiFiles(result);
        setWarnings(w);
        setError(null);
        setApiLoading(false);
        if (!result[activeFile]) {
          const first = Object.keys(result)[0] ?? 'main.tf';
          setActiveFile(first);
        }
      }
    }).catch(() => {
      if (!cancelled) {
        if (activeProject) {
          const { files: local, warnings: w } = apiTerraformService.generateFilesWithWarnings(
            activeProject.nodes,
            activeProject.edges,
            activeProject.provider,
          );
          setApiFiles(local);
          setWarnings(w);
          setError(null);
          setApiLoading(false);
        } else {
          setError('Failed to generate Terraform from backend service. Unable to reach backend generator.');
          setApiFiles(null);
          setApiLoading(false);
        }
      }
    });
    return () => { cancelled = true; };
  }, [activeProjectId, nodeCount, edgeCount, provider, architectureVersion, updatedAt, retryCount]);

  if (!activeProject) return null;

  if (nodeCount === 0) {
    return (
      <div className={clsx("flex-1 flex items-center justify-center", isLight ? "bg-slate-50" : "bg-gray-950")}>
        <div className="text-center px-8 py-12">
          <FileCode2 className={clsx("w-12 h-12 mx-auto mb-4", isLight ? "text-slate-300" : "text-gray-700")} />
          <p className={clsx("font-medium text-lg", isLight ? "text-slate-700" : "text-gray-400")}>No resources to generate</p>
          <p className={clsx("text-sm mt-1", isLight ? "text-slate-500" : "text-gray-600")}>Add resources to the canvas to generate Terraform code</p>
        </div>
      </div>
    );
  }

  if (apiLoading) {
    return (
      <div className={clsx("flex-1 flex items-center justify-center", isLight ? "bg-slate-50" : "bg-gray-950")}>
        <div className="text-center" role="status" aria-label="Generating Terraform">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className={clsx("font-medium", isLight ? "text-slate-800" : "text-gray-400")}>Generating Terraform…</p>
          <p className={clsx("text-sm mt-1", isLight ? "text-slate-500" : "text-gray-600")}>Calling backend Terraform generator</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={clsx("flex-1 flex items-center justify-center p-6", isLight ? "bg-slate-50" : "bg-gray-950")}>
        <div className={clsx(
          "text-center max-w-md border rounded-xl p-8 shadow-xl",
          isLight ? "bg-white border-rose-200" : "bg-gray-900 border-red-800/60"
        )}>
          <AlertTriangle className={clsx("w-12 h-12 mx-auto mb-4", isLight ? "text-rose-600" : "text-red-400")} aria-hidden="true" />
          <h3 className={clsx("font-semibold text-lg mb-2", isLight ? "text-slate-900" : "text-white")}>Terraform Generation Failed</h3>
          <p className={clsx("text-sm mb-6", isLight ? "text-slate-600" : "text-gray-400")}>{error}</p>
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
    const all = Object.entries(files).map(([name, content]) => `### ${name}\n${content}`).join('\n\n');
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
      const { files: result, warnings: w } = await apiTerraformService.generateFilesFromApiWithWarnings();
      setApiFiles(result);
      setWarnings(w);
      setError(null);
      setKey((k) => k + 1);
      if (!result[currentFile]) {
        const first = Object.keys(result)[0] ?? 'main.tf';
        setActiveFile(first);
      }
    } catch {
      setError('Failed to regenerate Terraform from backend service.');
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className={clsx("flex flex-1 min-h-0", isLight ? "bg-slate-50" : "bg-gray-950")}>
      {/* File tree */}
      <div className={clsx("w-48 flex flex-col shrink-0 border-r", isLight ? "bg-slate-100/80 border-slate-200" : "bg-gray-900 border-gray-800")}>
        <div className={clsx("flex items-center gap-2 px-3 py-2.5 border-b", isLight ? "border-slate-200" : "border-gray-800")}>
          <FolderOpen className={clsx("w-3.5 h-3.5", isLight ? "text-slate-500" : "text-gray-500")} />
          <span className={clsx("text-xs font-medium", isLight ? "text-slate-700" : "text-gray-400")}>terraform/</span>
        </div>
        <div className="flex-1 py-1">
          {fileNames.map((file) => (
            <button
              key={file}
              onClick={() => setActiveFile(file)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors text-left font-medium',
                currentFile === file 
                  ? (isLight ? 'bg-white text-blue-600 shadow-xs border-r-2 border-blue-600' : 'bg-gray-800 text-white')
                  : (isLight ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50')
              )}
            >
              <span className="text-[10px]">{FILE_ICONS[file] ?? '📄'}</span>
              <span className="font-mono">{file}</span>
            </button>
          ))}
        </div>
        <div className={clsx("p-2 border-t", isLight ? "border-slate-200" : "border-gray-800")}>
          <button
            onClick={handleDownload}
            className={clsx(
              "w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors border",
              isLight ? "bg-white border-slate-300 text-slate-700 hover:bg-slate-50 shadow-xs" : "bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700"
            )}
          >
            <Download className="w-3 h-3" />
            Download All
          </button>
        </div>
      </div>

      {/* Code area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Warnings banner */}
        {warnings.length > 0 && (
          <div className={clsx("shrink-0 border-b", isLight ? "bg-amber-50 border-amber-200" : "border-amber-800/50 bg-amber-950/40")}>
            <button
              onClick={() => setWarningsExpanded((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2 text-left"
            >
              <span className={clsx("flex items-center gap-2 text-xs font-medium", isLight ? "text-amber-800" : "text-amber-300")}>
                <AlertTriangle className={clsx("w-3.5 h-3.5", isLight ? "text-amber-600" : "text-amber-400")} />
                {warnings.length} resource{warnings.length === 1 ? '' : 's'} on this canvas will NOT deploy as generated — {warningsExpanded ? 'hide' : 'show'} details
              </span>
            </button>
            {warningsExpanded && (
              <ul className="px-4 pb-3 space-y-1.5">
                {warnings.map((w, i) => (
                  <li key={i} className={clsx("text-xs font-mono leading-snug", isLight ? "text-amber-900" : "text-amber-200/80")}>• {w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {/* Toolbar */}
        <div className={clsx("flex items-center justify-between px-4 py-2.5 border-b shrink-0", isLight ? "bg-white border-slate-200" : "bg-gray-900 border-gray-800")}>
          <div className="flex items-center gap-3">
            <Code2 className={clsx("w-4 h-4", isLight ? "text-blue-600" : "text-blue-400")} />
            <span className={clsx("font-mono text-sm font-semibold", isLight ? "text-slate-900" : "text-white")}>{currentFile}</span>
            <span className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-600")}>{lineCount} lines</span>
            <span className={clsx("text-xs px-1.5 py-0.5 rounded font-medium", isLight ? "bg-emerald-100 text-emerald-800" : "bg-emerald-900/30 text-emerald-400")}>API</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors border",
                isLight ? "bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700" : "bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-400 hover:text-white"
              )}
            >
              <RefreshCw className={clsx('w-3 h-3', regenerating && 'animate-spin')} />
              Regenerate
            </button>
            <button
              onClick={handleCopy}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors border",
                isLight ? "bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700" : "bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300 hover:text-white"
              )}
            >
              {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Code */}
        <div className={clsx("flex-1 overflow-auto", isLight ? "bg-slate-50" : "bg-gray-950")}>
          <div className="flex">
            {/* Line numbers */}
            <div className={clsx("shrink-0 select-none text-right pr-4 pt-4 pb-4 border-r", isLight ? "bg-slate-100/70 border-slate-200 text-slate-400" : "bg-gray-950 border-gray-800/50 text-gray-700")} style={{ minWidth: 44 }}>
              {code.split('\n').map((_, i) => (
                <div key={i} className="text-xs font-mono leading-5">{i + 1}</div>
              ))}
            </div>
            {/* Code */}
            <pre key={key} className={clsx("flex-1 p-4 text-xs font-mono leading-5 overflow-x-auto", isLight ? "text-slate-800" : "text-gray-300")}>
              {code.split('\n').map((line, i) => {
                let className = '';
                if (line.trimStart().startsWith('#')) className = isLight ? 'text-slate-400 italic' : 'text-gray-600';
                else if (/^\s*resource\s/.test(line) || /^\s*provider\s/.test(line) || /^\s*terraform\s/.test(line) || /^\s*variable\s/.test(line) || /^\s*output\s/.test(line)) className = isLight ? 'text-blue-600 font-bold' : 'text-blue-400';
                else if (/=\s*"/.test(line)) className = isLight ? 'text-emerald-700' : 'text-gray-200';
                else if (/^\s*(true|false)\s*$/.test(line.split('=')[1]?.trim() ?? '')) className = isLight ? 'text-amber-600 font-semibold' : 'text-orange-400';
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
        <div className={clsx("shrink-0 px-4 py-2 border-t flex items-center justify-between", isLight ? "bg-white border-slate-200" : "bg-gray-900 border-gray-800")}>
          <span className={clsx("text-xs font-mono", isLight ? "text-slate-500" : "text-gray-600")}>
            {activeProject.provider === 'multi' ? 'hashicorp/aws + hashicorp/azurerm' : `hashicorp/${activeProject.provider === 'aws' ? 'aws ~> 5.0' : 'azurerm ~> 3.0'}`}
          </span>
          <span className={clsx("text-xs", isLight ? "text-amber-700 font-medium" : "text-gray-700")}>⚠ Review before applying to production</span>
        </div>
      </div>
    </div>
  );
}
