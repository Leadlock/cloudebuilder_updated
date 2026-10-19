/**
 * Deploying a project from inside CloudBuilder is switched off until it has been run against a real subscription:
 * set CLOUDCRAFT_PROJECT_RELEASES=1 to turn it on. Everything else (Terraform access, the restricted-features list, approvals) still applies.
 */
export const projectReleasesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env['CLOUDCRAFT_PROJECT_RELEASES'] === '1';
export const PROJECT_RELEASES_OFF = 'Deploying a project from CloudBuilder is not switched on on this server (CLOUDCRAFT_PROJECT_RELEASES=1).';
