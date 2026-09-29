'use client';
import { X, ArrowRight, ArrowLeftRight, Network, ShieldAlert, ShieldCheck, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import type { CanvasEdge, CanvasNode } from '@/types';
import { getResourceDefinition } from '@/lib/resources';

interface ConnectionInspectorProps {
  edge: CanvasEdge;
  sourceNode: CanvasNode | null;
  targetNode: CanvasNode | null;
  onClose: () => void;
  onDelete: () => void;
}

function fieldRow(label: string, value: React.ReactNode) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-800/60 last:border-b-0">
      <span className="text-slate-500 text-xs font-medium">{label}</span>
      <span className="text-slate-200 text-xs font-mono text-right max-w-[60%] truncate">{value}</span>
    </div>
  );
}

export default function ConnectionInspector({ edge, sourceNode, targetNode, onClose, onDelete }: ConnectionInspectorProps) {
  const sourceDef = sourceNode ? getResourceDefinition(sourceNode.resourceType) : null;
  const targetDef = targetNode ? getResourceDefinition(targetNode.resourceType) : null;

  const validationStatus = edge.validationStatus;
  const isUnverified = !edge.protocol && !edge.port;

  return (
    <div className="w-full sm:w-80 sm:relative fixed inset-y-0 right-0 z-40 sm:z-20 bg-slate-900 border-l border-slate-800 flex flex-col h-full overflow-y-auto shadow-2xl animate-in slide-in-from-right duration-150">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-cyan-400" />
          <h3 className="text-white font-semibold text-sm">Connection</h3>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Source → Target */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold shrink-0" style={{ backgroundColor: sourceDef?.color ?? '#475569' }}>
              {sourceDef?.icon}
            </div>
            <span className="text-white text-xs font-medium truncate">{sourceNode?.label ?? edge.source}</span>
          </div>
          <div className="flex items-center justify-center py-1 text-slate-500">
            {edge.direction === 'bidirectional' ? <ArrowLeftRight className="w-3.5 h-3.5" /> : <ArrowRight className="w-3.5 h-3.5" />}
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold shrink-0" style={{ backgroundColor: targetDef?.color ?? '#475569' }}>
              {targetDef?.icon}
            </div>
            <span className="text-white text-xs font-medium truncate">{targetNode?.label ?? edge.target}</span>
          </div>
        </div>

        {/* Unverified protocol/port warning */}
        {isUnverified && (
          <div className="flex items-start gap-2 bg-amber-950/40 border border-amber-800/50 rounded-lg p-2.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-amber-300 text-xs leading-snug">
              No specific protocol/port rule matched this connection — treat it as unverified rather than a confirmed network fact.
            </p>
          </div>
        )}

        {/* Validation status */}
        {validationStatus && (
          <div className={clsx(
            'flex items-center gap-2 rounded-lg p-2.5 border',
            validationStatus === 'valid' && 'bg-emerald-950/40 border-emerald-800/50 text-emerald-300',
            validationStatus === 'warning' && 'bg-amber-950/40 border-amber-800/50 text-amber-300',
            validationStatus === 'invalid' && 'bg-rose-950/40 border-rose-800/50 text-rose-300',
          )}>
            {validationStatus === 'invalid' ? <ShieldAlert className="w-3.5 h-3.5 shrink-0" /> : <ShieldCheck className="w-3.5 h-3.5 shrink-0" />}
            <span className="text-xs font-medium capitalize">{validationStatus}</span>
            {edge.validationMessage && <span className="text-xs opacity-80 truncate">— {edge.validationMessage}</span>}
          </div>
        )}

        {/* Details */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl px-3">
          {fieldRow('Relationship', edge.relationshipType ?? edge.edgeType ?? 'Unclassified')}
          {fieldRow('Network Scope', edge.networkScope ?? '—')}
          {fieldRow('Protocol', edge.protocol ?? 'Not verified')}
          {fieldRow('Port', edge.port ?? 'Not verified')}
          {fieldRow('Direction', edge.direction ?? 'unidirectional')}
          {fieldRow('Label', edge.label ?? '—')}
          {edge.inferred !== undefined && fieldRow('Inferred', edge.inferred ? 'Yes (auto-generated)' : 'No (manually drawn)')}
        </div>

        {edge.reason && (
          <div className="text-slate-400 text-xs leading-relaxed px-1">{edge.reason}</div>
        )}

        <button
          onClick={onDelete}
          className="w-full px-3 py-2 bg-rose-950/40 hover:bg-rose-900/50 border border-rose-800/50 text-rose-300 rounded-lg text-xs font-medium transition-colors"
        >
          Delete Connection
        </button>
      </div>
    </div>
  );
}
