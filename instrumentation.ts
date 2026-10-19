/** Runs once when the server starts, before it takes a request. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/config/legacyEnv');
    const { assertProductionConfig } = await import('./lib/startup/productionChecks');
    try {
      assertProductionConfig();
    } catch (e) {
      // Exit, instead of staying up and answering every request with an error: a host (ECS, Kubernetes, systemd) restarts or alerts on an exit,
      // but would think a running process is healthy.
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }
}
