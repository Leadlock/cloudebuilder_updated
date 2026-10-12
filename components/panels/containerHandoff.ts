/**
 * Passes a container configuration between the canvas and Container Templates without a provider: the canvas node puts its configuration
 * here and switches view; the panel takes it on mount. `nodeId` remembers which node it came from so the panel can update that node.
 */
import type { ContainerConfig } from '@/lib/engines/containers/dockerTemplates';

interface Handoff { config: ContainerConfig; nodeId?: string }
let pending: Handoff | null = null;

export function sendToContainerTemplates(config: ContainerConfig, nodeId?: string): void { pending = { config, nodeId }; }

/** The waiting configuration, once: a second call returns null. */
export function takeContainerHandoff(): Handoff | null { const h = pending; pending = null; return h; }
