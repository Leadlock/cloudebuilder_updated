'use client';
import { useState, useEffect } from 'react';
import { useActiveProject } from '@/context/AppContext';
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
  const activeProject = useActiveProject();
  const [activeFile, setActiveFile] = useState<string>('main.tf');
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [key, setKey] = useState(0);
  const [apiFiles, setApiFiles] = useState<Record<string, string> | null>(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const activeProjectId = activeProject?.id ?? null;
  const nodeCount = activeProject?.nodes.length ?? 0;

  useEffect(() => {
    if (!activeProjectId || nodeCount === 0) {
      return;
    }
    let cancelled = false;
    apiTerraformService.generateFilesFromApi().then((result) => {
      if (!cancelled) {
        setApiFiles(result);
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
          const local = apiTerraformService.generateFiles(
            activeProject.nodes,
            activeProject.edges,
            activeProject.provider,
          );
          setApiFiles(local);
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
  }, [activeProjectId, nodeCount, retryCount]);

  if (!activeProject) return null;

  if (nodeCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950">
        <div className="text-center px-8 py-12">
          <FileCode2 className="w-12 h-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 font-medium text-lg">No resources to generate</p>
          <p className="text-gray-600 text-sm mt-1">Add resources to the canvas to generate Terraform code</p>
        </div>
      </div>
    );
  }

  if (apiLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950">
        <div className="text-center" role="status" aria-label="Generating Terraform">
          <div className="w-12 h-12 border-4 border-blue-700 border-t-blue-400 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 font-medium">Generating Terraform…</p>
          <p className="text-gray-600 text-sm mt-1">Calling backend Terraform generator</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950 p-6">
        <div className="text-center max-w-md bg-gray-900 border border-red-800/60 rounded-xl p-8 shadow-xl">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" aria-hidden="true" />
          <h3 className="text-white font-semibold text-lg mb-2">Terraform Generation Failed</h3>
          <p className="text-gray-400 text-sm mb-6">{error}</p>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-4 py-2 bg-red-800 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
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
      const result = await apiTerraformService.generateFilesFromApi();
      setApiFiles(result);
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
    <div className="flex flex-1 min-h-0 bg-gray-950">
      {/* File tree */}
      <div className="w-48 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800">
          <FolderOpen className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-gray-400 text-xs font-medium">terraform/</span>
        </div>
        <div className="flex-1 py-1">
          {fileNames.map((file) => (
            <button
              key={file}
              onClick={() => setActiveFile(file)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors text-left',
                currentFile === file ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              )}
            >
              <span className="text-[10px]">{FILE_ICONS[file] ?? '📄'}</span>
              <span className="font-mono">{file}</span>
            </button>
          ))}
        </div>
        <div className="p-2 border-t border-gray-800">
          <button
            onClick={handleDownload}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg text-xs transition-colors"
          >
            <Download className="w-3 h-3" />
            Download All
          </button>
        </div>
      </div>

      {/* Code area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 bg-gray-900 shrink-0">
          <div className="flex items-center gap-3">
            <Code2 className="w-4 h-4 text-blue-400" />
            <span className="text-white font-mono text-sm font-medium">{currentFile}</span>
            <span className="text-gray-600 text-xs">{lineCount} lines</span>
            <span className="text-xs px-1.5 py-0.5 bg-emerald-900/30 text-emerald-400 rounded">API</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="flex items-center gap-1.5 px-3 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-xs transition-colors"
            >
              <RefreshCw className={clsx('w-3 h-3', regenerating && 'animate-spin')} />
              Regenerate
            </button>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white rounded-lg text-xs transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Code */}
        <div className="flex-1 overflow-auto">
          <div className="flex">
            {/* Line numbers */}
            <div className="shrink-0 select-none text-right pr-4 pt-4 pb-4 bg-gray-950 border-r border-gray-800/50" style={{ minWidth: 44 }}>
              {code.split('\n').map((_, i) => (
                <div key={i} className="text-gray-700 text-xs font-mono leading-5">{i + 1}</div>
              ))}
            </div>
            {/* Code */}
            <pre key={key} className="flex-1 p-4 text-xs font-mono text-gray-300 leading-5 overflow-x-auto">
              {code.split('\n').map((line, i) => {
                // Basic syntax highlighting
                let className = '';
                if (line.trimStart().startsWith('#')) className = 'text-gray-600';
                else if (/^\s*resource\s/.test(line) || /^\s*provider\s/.test(line) || /^\s*terraform\s/.test(line) || /^\s*variable\s/.test(line) || /^\s*output\s/.test(line)) className = 'text-blue-400';
                else if (/=\s*"/.test(line)) className = 'text-gray-200';
                else if (/^\s*(true|false)\s*$/.test(line.split('=')[1]?.trim() ?? '')) className = 'text-orange-400';
                return (
                  <div key={i} className={className ?? 'text-gray-300'}>
                    {line || ' '}
                  </div>
                );
              })}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-2 border-t border-gray-800 bg-gray-900 flex items-center justify-between">
          <span className="text-gray-600 text-xs">
            {activeProject.provider === 'multi' ? 'hashicorp/aws + hashicorp/azurerm' : `hashicorp/${activeProject.provider === 'aws' ? 'aws ~> 5.0' : 'azurerm ~> 3.0'}`}
          </span>
          <span className="text-gray-700 text-xs">⚠ Review before applying to production</span>
        </div>
      </div>
    </div>
  );
}
