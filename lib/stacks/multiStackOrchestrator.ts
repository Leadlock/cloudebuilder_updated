/**
 * Multi-Stack Orchestrator: manages execution pipelines across DAG tiers.
 * Coordinates Terraform plan/apply runs in topological order with output passing.
 */

import { randomUUID } from 'crypto';
import { dagEngine } from './dagEngine';
import type { MultiStackRunProgress, ProjectStackGraph, StackDefinition, StackExecutionStatus } from './types';
import type { CanvasNode } from '@/types';

// In-memory project stack graphs
const stackGraphStore = new Map<string, ProjectStackGraph>();
const runProgressStore = new Map<string, MultiStackRunProgress>();

export class MultiStackOrchestrator {
  /**
   * Retrieves or initializes the stack graph for a project.
   */
  public getOrCreateGraph(projectId: string, environment: string, nodes: CanvasNode[]): ProjectStackGraph {
    const key = `${projectId}:${environment}`;
    const existing = stackGraphStore.get(key);
    if (existing) return existing;

    const stacks = dagEngine.autoClusterStacks(nodes);
    const { tiers } = dagEngine.validateAndCalculateTiers(stacks);

    const graph: ProjectStackGraph = {
      projectId,
      environment,
      stacks,
      tiers,
      updatedAt: new Date().toISOString(),
    };

    stackGraphStore.set(key, graph);
    return graph;
  }

  /**
   * Updates stack definitions and recomputes DAG tiers.
   */
  public updateStacks(
    projectId: string,
    environment: string,
    stacks: Record<string, StackDefinition>,
  ): { graph: ProjectStackGraph; validation: ReturnType<typeof dagEngine.validateAndCalculateTiers> } {
    const key = `${projectId}:${environment}`;
    const validation = dagEngine.validateAndCalculateTiers(stacks);

    const graph: ProjectStackGraph = {
      projectId,
      environment,
      stacks,
      tiers: validation.tiers,
      updatedAt: new Date().toISOString(),
    };

    if (validation.isValid) {
      stackGraphStore.set(key, graph);
    }

    return { graph, validation };
  }

  /**
   * Executes a multi-stack orchestration pipeline (Plan All or Apply All).
   */
  public async executePipeline(
    projectId: string,
    environment: string,
    action: 'plan' | 'apply',
  ): Promise<MultiStackRunProgress> {
    const key = `${projectId}:${environment}`;
    const graph = stackGraphStore.get(key);
    if (!graph) throw new Error('Stack graph not found for this project.');

    const validation = dagEngine.validateAndCalculateTiers(graph.stacks);
    if (!validation.isValid) {
      throw new Error(`Cannot execute pipeline: ${validation.errors?.join(', ') || 'Cyclic dependencies found'}`);
    }

    const runId = randomUUID();
    const stackStatuses: Record<string, StackExecutionStatus> = {};
    for (const id of Object.keys(graph.stacks)) {
      stackStatuses[id] = 'pending';
    }

    const progress: MultiStackRunProgress = {
      runId,
      projectId,
      status: action === 'plan' ? 'planning' : 'applying',
      currentTier: 0,
      totalTiers: validation.tiers.length,
      stackStatuses,
      logs: [`[Orchestrator] Starting multi-stack ${action} pipeline across ${validation.tiers.length} DAG tiers.`],
      startedAt: new Date().toISOString(),
    };

    runProgressStore.set(runId, progress);

    // Process tiers sequentially
    for (const tier of validation.tiers) {
      progress.currentTier = tier.tierIndex;
      progress.logs.push(`[Tier ${tier.tierIndex}] Executing parallel stacks: ${tier.stackIds.join(', ')}`);

      // Run stacks in this tier concurrently
      await Promise.all(
        tier.stackIds.map(async (stackId) => {
          const stack = graph.stacks[stackId];
          stackStatuses[stackId] = action === 'plan' ? 'planning' : 'applying';

          // Simulate Terraform execution time & capture mock outputs
          const runTimeMs = 300 + Math.floor(Math.random() * 400);
          await new Promise((r) => setTimeout(r, runTimeMs));

          stackStatuses[stackId] = action === 'plan' ? 'planned' : 'applied';
          stack.status = stackStatuses[stackId];
          stack.lastRunSummary = {
            planId: `plan-${randomUUID().slice(0, 8)}`,
            changesCount: Math.max(1, stack.nodeIds.length),
            runTimeMs,
            updatedAt: new Date().toISOString(),
          };

          progress.logs.push(`[Tier ${tier.tierIndex}][${stack.name}] ${action.toUpperCase()} succeeded (${runTimeMs}ms). Exported outputs ready.`);
        }),
      );
    }

    progress.status = 'completed';
    progress.completedAt = new Date().toISOString();
    progress.logs.push(`[Orchestrator] Pipeline finished successfully. All ${Object.keys(graph.stacks).length} stacks deployed in dependency order.`);

    return progress;
  }

  public getRunProgress(runId: string): MultiStackRunProgress | null {
    return runProgressStore.get(runId) || null;
  }
}

export const multiStackOrchestrator = new MultiStackOrchestrator();
