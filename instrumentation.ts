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
    // Write the built-in templates to the database (best effort: the gallery still has them from the code if the database is not ready).
    void (async () => {
      try {
        const [{ PgTemplateStore }, { syncBuiltInTemplates }] = await Promise.all([import('./lib/templates/templateStore'), import('./lib/templates/sync')]);
        const r = await syncBuiltInTemplates(new PgTemplateStore());
        if (r.added + r.updated + r.removed > 0) console.log(`[templates] built-in templates synced: ${r.added} added, ${r.updated} updated, ${r.removed} removed`);
      } catch (e) { console.warn('[templates] could not sync the built-in templates:', e instanceof Error ? e.message : e); }
    })();
  }
}
