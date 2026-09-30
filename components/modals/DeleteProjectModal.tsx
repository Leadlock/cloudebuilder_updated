'use client';

import React, { useEffect } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

interface DeleteProjectModalProps {
  isOpen: boolean;
  projectName: string;
  projectId: string;
  onConfirm: (projectId: string) => void;
  onCancel: () => void;
}

export default function DeleteProjectModal({
  isOpen,
  projectName,
  projectId,
  onConfirm,
  onCancel,
}: DeleteProjectModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
        onClick={onCancel}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-md bg-gradient-to-b from-gray-900 to-gray-950 border border-red-500/30 rounded-2xl shadow-2xl shadow-red-950/40 p-6 z-10 animate-in zoom-in-95 duration-200">
        {/* Close Button */}
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors"
          title="Cancel"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Warning Icon & Header */}
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center shrink-0 text-red-400 shadow-inner">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-white font-bold text-lg leading-tight">Delete Project</h3>
            <p className="text-gray-400 text-xs mt-1">
              This action cannot be undone. Are you sure you want to delete this project?
            </p>
          </div>
        </div>

        {/* Project Details Box */}
        <div className="mt-4 p-3.5 bg-gray-950/80 border border-gray-800 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-xs">Project Name:</span>
            <span className="text-white text-xs font-semibold max-w-[240px] truncate" title={projectName}>
              {projectName}
            </span>
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-800/80 text-[11px] text-red-400/90">
            <span>Impact:</span>
            <span>All canvases, subnets & environments will be deleted</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium text-gray-300 hover:text-white bg-gray-800/80 hover:bg-gray-800 border border-gray-700/80 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(projectId)}
            className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 rounded-xl shadow-lg shadow-red-600/30 transition-all flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete Project</span>
          </button>
        </div>
      </div>
    </div>
  );
}
