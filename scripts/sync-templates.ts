/** Writes the built-in architecture templates to the database: npm run templates:sync */
import '../lib/config/legacyEnv';
import { PgTemplateStore } from '../lib/templates/templateStore';
import { syncBuiltInTemplates } from '../lib/templates/sync';

syncBuiltInTemplates(new PgTemplateStore())
  .then((r) => { console.log(`built-in templates: ${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.unchanged} unchanged`); process.exit(0); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
