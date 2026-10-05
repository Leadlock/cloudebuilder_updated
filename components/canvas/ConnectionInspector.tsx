'use client';
import { X, ArrowRight, ArrowLeftRight, Network, ShieldAlert, ShieldCheck, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import type { CanvasEdge, CanvasNode } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { useApp } from '@/context/AppContext';

interface ConnectionInspectorProps {
  edge: CanvasEdge;
  sourceNode: CanvasNode | null;
  targetNode: CanvasNode | null;
  onClose: () => void;
  onDelete: () => void;
}

function fieldRow(label: string, value: React.ReactNode, isLight = false) {
  return (
    <div className={clsx('flex items-center justify-between py-2 border-b last:border-b-0', isLight ? 'border-slate-200' : 'border-slate-800/60')}>
      <span className={clsx('text-xs font-medium', isLight ? 'text-slate-500' : 'text-slate-500')}>{label}</span>
      <span className={clsx('text-xs font-mono text-right max-w-[60%] truncate', isLight ? 'text-slate-800 font-medium' : 'text-slate-200')}>{value}</span>
    </div>
  );
}

export default function ConnectionInspector({ edge, sourceNode, targetNode, onClose, onDelete }: ConnectionInspectorProps) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const sourceDef = sourceNode ? getResourceDefinition(sourceNode.resourceType) : null;
  const targetDef = targetNode ? getResourceDefinition(targetNode.resourceType) : null;

  const validationStatus = edge.validationStatus;
  const isUnverified = !edge.protocol && !edge.port;

  return (
    <div className={clsx(
      'w-full sm:w-80 sm:relative fixed inset-y-0 right-0 z-40 sm:z-20 border-l flex flex-col h-full overflow-y-auto shadow-2xl animate-in slide-in-from-right duration-150',
      isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-slate-900 border-slate-800 text-white'
    )}>
      <div className={clsx(
        'flex items-center justify-between px-4 py-3 border-b',
        isLight ? 'border-slate-200 bg-slate-50' : 'border-slate-800 bg-slate-950/40'
      )}>
        <div className="flex items-center gap-2">
          <Network className={clsx('w-4 h-4', isLight ? 'text-blue-600' : 'text-cyan-400')} />
          <h3 className={clsx('font-semibold text-sm', isLight ? 'text-slate-900' : 'text-white')}>Connection</h3>
        </div>
        <button
          onClick={onClose}
          className={clsx('p-1 rounded-lg transition-colors', isLight ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100' : 'text-slate-500 hover:text-white hover:bg-slate-800')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Source → Target */}
        <div className={clsx('border rounded-xl p-3', isLight ? 'bg-slate-50 border-slate-200 shadow-sm' : 'bg-slate-950 border-slate-800')}>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold shrink-0" style={{ backgroundColor: sourceDef?.color ?? '#475569' }}>
              {sourceDef?.icon}
            </div>
            <span className={clsx('text-xs font-medium truncate', isLight ? 'text-slate-900' : 'text-white')}>{sourceNode?.label ?? edge.source}</span>
          </div>
          <div className="flex items-center justify-center py-1 text-slate-400">
            {edge.direction === 'bidirectional' ? <ArrowLeftRight className="w-3.5 h-3.5" /> : <ArrowRight className="w-3.5 h-3.5" />}
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold shrink-0" style={{ backgroundColor: targetDef?.color ?? '#475569' }}>
              {targetDef?.icon}
            </div>
            <span className={clsx('text-xs font-medium truncate', isLight ? 'text-slate-900' : 'text-white')}>{targetNode?.label ?? edge.target}</span>
          </div>
        </div>

        {/* Unverified protocol/port warning */}
        {isUnverified && (
          <div className={clsx(
            'flex items-start gap-2 rounded-lg p-2.5 border',
            isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-950/40 border-amber-800/50 text-amber-300'
          )}>
            <AlertTriangle className={clsx('w-3.5 h-3.5 shrink-0 mt-0.5', isLight ? 'text-amber-600' : 'text-amber-400')} />
            <p className={clsx('text-xs leading-snug', isLight ? 'text-amber-800' : 'text-amber-300')}>
              No specific protocol/port rule matched this connection — treat it as unverified rather than a confirmed network fact.
            </p>
          </div>
        )}

        {/* Validation status */}
        {validationStatus && (
          <div className={clsx(
            'flex items-center gap-2 rounded-lg p-2.5 border',
            validationStatus === 'valid' && (isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-emerald-950/40 border-emerald-800/50 text-emerald-300'),
            validationStatus === 'warning' && (isLight ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-amber-950/40 border-amber-800/50 text-amber-300'),
            validationStatus === 'invalid' && (isLight ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-rose-950/40 border-rose-800/50 text-rose-300'),
          )}>
            {validationStatus === 'invalid' ? <ShieldAlert className="w-3.5 h-3.5 shrink-0" /> : <ShieldCheck className="w-3.5 h-3.5 shrink-0" />}
            <span className="text-xs font-medium capitalize">{validationStatus}</span>
            {edge.validationMessage && <span className="text-xs opacity-80 truncate">— {edge.validationMessage}</span>}
          </div>
        )}

        {/* Details */}
        <div className={clsx('border rounded-xl px-3', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950 border-slate-800')}>
          {fieldRow('Relationship', edge.relationshipType ?? edge.edgeType ?? 'Unclassified', isLight)}
          {fieldRow('Network Scope', edge.networkScope ?? '—', isLight)}
          {fieldRow('Protocol', edge.protocol ?? 'Not verified', isLight)}
          {fieldRow('Port', edge.port ?? 'Not verified', isLight)}
          {fieldRow('Direction', edge.direction ?? 'unidirectional', isLight)}
          {fieldRow('Label', edge.label ?? '—', isLight)}
          {edge.inferred !== undefined && fieldRow('Inferred', edge.inferred ? 'Yes (auto-generated)' : 'No (manually drawn)', isLight)}
        </div>

        {edge.reason && (
          <div className={clsx('text-xs leading-relaxed px-1', isLight ? 'text-slate-600' : 'text-slate-400')}>{edge.reason}</div>
        )}

        <button
          onClick={onDelete}
          className={clsx(
            'w-full px-3 py-2 border rounded-lg text-xs font-medium transition-colors',
            isLight
              ? 'bg-rose-50 hover:bg-rose-100 border-rose-200 text-rose-700'
              : 'bg-rose-950/40 hover:bg-rose-900/50 border-rose-800/50 text-rose-300'
          )}
        >
          Delete Connection
        </button>
      </div>
    </div>
  );
}
