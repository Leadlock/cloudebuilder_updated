'use client';

import React, { useState } from 'react';
import { AlertTriangle, Trash2, X, Loader2, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import type { Project, CloudProvider } from '@/types';

interface DeleteProjectModalProps {
  isOpen: boolean;
  project: Project | { id: string; name: string; provider?: CloudProvider; resourceCount?: number } | null;
  isAdmin: boolean;
  onClose: () => void;
  onConfirm: (projectId: string) => Promise<void> | void;
}

export default function DeleteProjectModal({
  isOpen,
  project,
  isAdmin,
  onClose,
  onConfirm,
}: DeleteProjectModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !project) return null;

  async function handleDelete() {
    if (!project) return;
    if (!isAdmin) {
      setError('Only organization administrators can delete projects.');
      return;
    }

    try {
      setIsDeleting(true);
      setError(null);
      await onConfirm(project.id);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete project. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-project-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDeleting) onClose();
      }}
    >
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 text-slate-100 animate-in zoom-in-95 duration-150">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isDeleting}
          className="absolute top-4 right-4 text-slate-500 hover:text-slate-300 disabled:opacity-50 p-1 rounded-lg hover:bg-slate-800 transition-colors"
          title="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-start gap-4 mb-4">
          <div className="w-12 h-12 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center justify-center shrink-0">
            {isAdmin ? <Trash2 className="w-6 h-6" /> : <ShieldAlert className="w-6 h-6" />}
          </div>
          <div className="flex-1 min-w-0 pr-4">
            <h3 id="delete-project-title" className="text-lg font-bold text-white leading-snug truncate">
              {isAdmin ? 'Delete Project' : 'Admin Access Required'}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {isAdmin
                ? 'This action cannot be undone and will permanently delete the project.'
                : 'Project deletion is restricted to organization administrators.'}
            </p>
          </div>
        </div>

        {/* Project details card */}
        <div className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-3.5 mb-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">Project Name:</span>
            <span className="text-xs font-semibold text-white truncate max-w-[200px]">{project.name}</span>
          </div>
          {project.provider && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Provider:</span>
              <span className={clsx(
                "text-[10px] uppercase font-bold px-2 py-0.5 rounded border",
                project.provider === 'aws' ? "bg-orange-500/10 text-orange-400 border-orange-500/30" :
                project.provider === 'azure' ? "bg-blue-500/10 text-blue-400 border-blue-500/30" :
                "bg-purple-500/10 text-purple-400 border-purple-500/30"
              )}>
                {project.provider}
              </span>
            </div>
          )}
          {typeof project.resourceCount === 'number' && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Resources:</span>
              <span className="text-xs font-mono text-slate-300">{project.resourceCount} nodes</span>
            </div>
          )}
        </div>

        {/* Admin Warning vs Non-Admin Notice */}
        {isAdmin ? (
          <div className="bg-rose-950/30 border border-rose-900/50 rounded-xl p-3 mb-5 flex items-start gap-2.5 text-xs text-rose-300">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Are you sure you want to delete <strong className="text-white">{project.name}</strong>? All canvas nodes, environment states, and database records will be permanently removed.
            </p>
          </div>
        ) : (
          <div className="bg-amber-950/30 border border-amber-900/50 rounded-xl p-3 mb-5 flex items-start gap-2.5 text-xs text-amber-300">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              You do not have permission to delete projects. Please contact an organization administrator to delete <strong className="text-white">{project.name}</strong>.
            </p>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="bg-red-950/60 border border-red-800 rounded-lg p-3 mb-4 text-xs text-red-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors"
          >
            Cancel
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 active:from-red-700 active:to-rose-700 disabled:opacity-50 rounded-lg shadow-lg shadow-rose-950/50 flex items-center gap-2 transition-all cursor-pointer"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Deleting from database...</span>
                </>
              ) : (
                <>
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Project</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
