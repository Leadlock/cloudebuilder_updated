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
    deploy:             <DeployPanel />,
    wizard:             <ArchitectureWizard />,
    templates:          <TemplateGallery />,
    'ai-generator':     <AIGenerator />,
    advisor:            <AdvisorPanel />,
    'disaster-recovery':<DisasterRecovery />,
    import:             <ImportPanel />,
    history:            <VersionHistory />,
    environments:       <EnvironmentsPanel />,
    review:             <ReviewWorkflowPanel />,
  };

  return <>{map[activeView] ?? <Dashboard />}</>;
}

export default function Home() {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar />
        <main className="flex flex-1 min-h-0 overflow-hidden">
          <MainContent />
        </main>
      </div>
    </div>
  );
}
