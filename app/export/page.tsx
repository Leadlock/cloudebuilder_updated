'use client';
import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppProvider, useApp } from '@/context/AppContext';
import InfraCanvas from '@/components/canvas/InfraCanvas';

function ExportCanvas() {
  const searchParams = useSearchParams();
  const architectureId = searchParams.get('architectureId');
  const theme = searchParams.get('theme') || 'light';
  const { dispatch, state } = useApp();

  useEffect(() => {
    if (architectureId && !state.projects.find(p => p.id === architectureId)) {
      // Create a temporary project to hold the architecture for export if it's not loaded
      // In a real app we'd fetch this from the backend
      dispatch({ type: 'CREATE_PROJECT', provider: 'multi', name: 'Exported Architecture' });
      // Since it creates with a new ID, we don't have the exact ID here, but this is a stub
    } else if (architectureId) {
      dispatch({ type: 'SET_ACTIVE_PROJECT', id: architectureId });
    }
  }, [architectureId, dispatch, state.projects]);

  return (
    <div className={`w-screen h-screen overflow-hidden ${theme === 'dark' ? 'bg-slate-950' : 'bg-slate-50'}`}>
      {/* Hide controls for export via CSS */}
      <style>{`
        .react-flow__controls, .react-flow__minimap, header, .sidebar, .canvas-toolbar, .properties-panel {
          display: none !important;
        }
      `}</style>
      <div className="w-full h-full">
        {architectureId ? <InfraCanvas /> : <div className="p-4">Missing architectureId</div>}
      </div>
    </div>
  );
}

export default function ExportPage() {
  return (
    <AppProvider>
      <Suspense fallback={<div className="p-4 text-white">Loading for export...</div>}>
        <ExportCanvas />
      </Suspense>
    </AppProvider>
  );
}
