'use client';
import LockedFeature from '@/components/panels/LockedFeature';
import { RESTRICTED_VIEWS } from '@/lib/auth/restrictedFeatures';
import Sidebar from '@/components/layout/Sidebar';
import TopBar from '@/components/layout/TopBar';
import Dashboard from '@/components/dashboard/Dashboard';
import InfraCanvas from '@/components/canvas/InfraCanvas';
import TerraformPanel from '@/components/panels/TerraformPanel';
import SecurityPanel from '@/components/panels/SecurityPanel';
import CostPanel from '@/components/panels/CostPanel';
import DeployPanel from '@/components/panels/DeployPanel';
import ArchitectureWizard from '@/components/wizard/ArchitectureWizard';
import TemplateGallery from '@/components/templates/TemplateGallery';
import AIGenerator from '@/components/ai/AIGenerator';
import AdvisorPanel from '@/components/panels/AdvisorPanel';
import DisasterRecovery from '@/components/panels/DisasterRecovery';
import ImportPanel from '@/components/panels/ImportPanel';
import ContainerTemplatesPanel from '@/components/panels/ContainerTemplatesPanel';
import CloudAccountsPanel from '@/components/panels/CloudAccountsPanel';
import VersionHistory from '@/components/panels/VersionHistory';
import EnvironmentsPanel from '@/components/panels/EnvironmentsPanel';
import WellArchitectedReview from '@/components/panels/WellArchitectedReview';
import ReviewWorkflowPanel from '@/components/panels/ReviewWorkflowPanel';
import AnalyzePanel from '@/components/panels/AnalyzePanel';
import DriftPanel from '@/components/panels/DriftPanel';
import MultiStackPanel from '@/components/panels/MultiStackPanel';
import CostComparisonPanel from '@/components/panels/CostComparisonPanel';
import TeamPanel from '@/components/panels/TeamPanel';
import PolicyPanel from '@/components/panels/PolicyPanel';
import OperatorAccessPanel from '@/components/panels/OperatorAccessPanel';
import LoginModal from '@/components/auth/LoginModal';
import { useApp } from '@/context/AppContext';
import { AppView } from '@/types';

import { useState, useEffect } from 'react';
import clsx from 'clsx';

function MainContent() {
  const { state } = useApp();
  const { activeView } = state;
  const [renderedViews, setRenderedViews] = useState<Set<AppView>>(() => new Set([activeView]));

  useEffect(() => {
    setRenderedViews((prev) => {
      if (prev.has(activeView)) return prev;
      const next = new Set(prev);
      next.add(activeView);
      return next;
    });
  }, [activeView]);

  const map: Record<AppView, React.ReactNode> = {
    dashboard:          <Dashboard />,
    canvas:             <InfraCanvas />,
    terraform:          <TerraformPanel />,
    stacks:             <MultiStackPanel />,
    drift:              <DriftPanel />,
    security:           <SecurityPanel />,
    'well-architected': <WellArchitectedReview />,
    cost:               <CostPanel />,
    'cost-comparison':  <CostComparisonPanel />,
    deploy:             <DeployPanel />,
    wizard:             <ArchitectureWizard />,
    templates:          <TemplateGallery />,
    'ai-generator':     <AIGenerator />,
    analyze:            <AnalyzePanel />,
    advisor:            <AdvisorPanel />,
    'disaster-recovery':<DisasterRecovery />,
    import:             <ImportPanel />,
    'container-templates': <ContainerTemplatesPanel />,
    accounts:           <CloudAccountsPanel />,
    history:            <VersionHistory />,
    environments:       <EnvironmentsPanel />,
    review:             <ReviewWorkflowPanel />,
    policy:             <PolicyPanel />,
    'operator-access':  <OperatorAccessPanel />,
    team:               <TeamPanel />,
  };

  return (
    <div className="flex-1 min-h-0 min-w-0 w-full h-full relative overflow-hidden">
      {(Object.keys(map) as AppView[]).map((viewKey) => {
        if (!renderedViews.has(viewKey)) return null;
        const isActive = activeView === viewKey;
        return (
          <div
            key={viewKey}
            className={clsx(
              'w-full h-full flex flex-col min-h-0 min-w-0 overflow-hidden',
              isActive ? 'block' : 'hidden'
            )}
          >
            {RESTRICTED_VIEWS.has(viewKey) && state.currentUser?.restrictedFeatures === false ? <LockedFeature /> : map[viewKey]}
          </div>
        );
      })}
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';

  // Don't decide anything until the /api/auth/session check has resolved —
  // otherwise a returning user with a valid cookie sees the login modal
  // flash (and can even submit it) before their session restores.
  if (!state.sessionChecked) {
    return <div className={`flex h-screen items-center justify-center ${isLight ? 'bg-slate-50' : 'bg-gray-950'}`} />;
  }

  if (!state.currentUser) {
    return (
      <div className={`flex h-screen items-center justify-center ${isLight ? 'bg-slate-50' : 'bg-gray-950'}`}>
        <LoginModal
          isOpen
          onSuccess={(user) => {
            dispatch({ type: 'SET_USER', user });
            dispatch({ type: 'SET_LOGIN_MODAL', open: false });
          }}
        />
      </div>
    );
  }

  return <>{children}</>;
}

export default function Home() {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  return (
    <AuthGate>
      <div className={`flex h-screen overflow-hidden ${isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-white'}`}>
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <TopBar />
          <main className="flex flex-1 min-h-0 overflow-hidden">
            <MainContent />
          </main>
        </div>
      </div>
    </AuthGate>
  );
}
