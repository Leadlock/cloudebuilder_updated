'use client';
/**
 * "Export to draw.io": the architecture as draw.io code to paste, or as a .drawio file to download. Everything is made in the browser
 * (lib/engines/export/drawio.ts): nothing about the architecture is sent anywhere.
 */
import { useMemo, useState } from 'react';
import { Check, Copy, Download, X, Workflow } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { useEscapeKey } from '@/lib/ui/useEscapeKey';
import { drawioFileName, drawioFileXml, drawioModelXml } from '@/lib/engines/export/drawio';
import type { CanvasEdge, CanvasNode } from '@/types';

export default function DrawioExportDialog({ title, nodes, edges, onClose }: { title: string; nodes: CanvasNode[]; edges: CanvasEdge[]; onClose: () => void }) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  useEscapeKey(onClose);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const code = useMemo(() => drawioModelXml({ title, nodes, edges }), [title, nodes, edges]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setNote(null);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Some browsers refuse clipboard access: select the text so Ctrl+C / Cmd+C works.
      const box = document.getElementById('drawio-code') as HTMLTextAreaElement | null;
      box?.focus();
      box?.select();
      setNote('Your browser did not allow copying. The code is selected: press Ctrl+C (Cmd+C on a Mac).');
    }
  }

  function download() {
    const blob = new Blob([drawioFileXml({ title, nodes, edges })], { type: 'application/vnd.jgraph.mxfile' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = drawioFileName(title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const muted = isLight ? 'text-slate-600' : 'text-gray-400';
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${isLight ? 'bg-slate-900/40' : 'bg-black/70'} backdrop-blur-sm p-4`} role="dialog" aria-modal="true" aria-labelledby="drawio-title">
      <div className={`w-full max-w-2xl max-h-[90vh] overflow-y-auto ${isLight ? 'bg-white border-slate-200 shadow-2xl' : 'bg-gray-900 border-gray-800 shadow-2xl'} border rounded-2xl p-5 space-y-4`}>
        <div className="flex items-start gap-3">
          <div className={`p-2.5 rounded-xl ${isLight ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-blue-950/60 text-blue-400'} shrink-0`}><Workflow className="w-5 h-5" /></div>
          <div className="flex-1 space-y-1">
            <h3 id="drawio-title" className={`${isLight ? 'text-slate-900' : 'text-white'} font-semibold text-sm`}>Export to draw.io</h3>
            <p className={`${muted} text-xs leading-relaxed`}>
              {nodes.length} resource{nodes.length === 1 ? '' : 's'} and {edges.length} connection{edges.length === 1 ? '' : 's'}. Groups such as a VPC are real draw.io containers, so you can keep editing the diagram there.
              This is made in your browser: nothing is sent anywhere.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`p-1 rounded-lg ${isLight ? 'text-slate-500 hover:bg-slate-100' : 'text-gray-400 hover:bg-gray-800'}`}><X className="w-4 h-4" /></button>
        </div>

        <ol className={`${muted} text-xs leading-relaxed list-decimal pl-5 space-y-0.5`}>
          <li>Open <strong>app.diagrams.net</strong> (or the draw.io desktop app) and start a blank diagram.</li>
          <li>Choose <strong>Extras, then Edit Diagram</strong>, delete what is there, paste the code below and press <strong>OK</strong>.</li>
          <li>Or download the file and open it with <strong>File, Open from, Device</strong>.</li>
        </ol>

        <label htmlFor="drawio-code" className={`block text-xs font-medium ${isLight ? 'text-slate-700' : 'text-gray-300'}`}>draw.io code</label>
        <textarea id="drawio-code" readOnly value={code} rows={10} spellCheck={false}
          className={`w-full rounded-lg border px-3 py-2 text-[11px] font-mono ${isLight ? 'bg-slate-50 border-slate-300 text-slate-800' : 'bg-gray-950 border-gray-700 text-gray-200'}`} />
        {note && <p role="status" className="text-xs text-amber-500">{note}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={copy} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold ${isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-800' : 'bg-gray-800 hover:bg-gray-700 text-gray-100'}`}>
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied' : 'Copy code'}
          </button>
          <button type="button" onClick={download} className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white">
            <Download className="w-3.5 h-3.5" />Download .drawio
          </button>
        </div>
      </div>
    </div>
  );
}
