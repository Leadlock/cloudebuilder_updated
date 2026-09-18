'use client';
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
import VersionHistory from '@/components/panels/VersionHistory';
import EnvironmentsPanel from '@/components/panels/EnvironmentsPanel';
import WellArchitectedReview from '@/components/panels/WellArchitectedReview';
import ReviewWorkflowPanel from '@/components/panels/ReviewWorkflowPanel';
import AnalyzePanel from '@/components/panels/AnalyzePanel';
import CostComparisonPanel from '@/components/panels/CostComparisonPanel';
import TeamPanel from '@/components/panels/TeamPanel';
import LoginModal from '@/components/auth/LoginModal';
import { useApp } from '@/context/AppContext';
import { AppView } from '@/types';

function MainContent() {
  const { state } = useApp();
  const { activeView } = state;

  const map: Record<AppView, React.ReactNode> = {
    dashboard:          <Dashboard />,
    canvas:             <InfraCanvas />,
    terraform:          <TerraformPanel />,
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
    history:            <VersionHistory />,
    environments:       <EnvironmentsPanel />,
    review:             <ReviewWorkflowPanel />,
    team:               <TeamPanel />,
  };

  return <>{map[activeView] ?? <Dashboard />}</>;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = useApp();

  // Don't decide anything until the /api/auth/session check has resolved —
  // otherwise a returning user with a valid cookie sees the login modal
  // flash (and can even submit it) before their session restores.
  if (!state.sessionChecked) {
    return <div className="flex h-screen items-center justify-center bg-gray-950" />;
  }

  if (!state.currentUser) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950">
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
  return (
    <AuthGate>
      <div className="flex h-screen overflow-hidden bg-gray-950">
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
