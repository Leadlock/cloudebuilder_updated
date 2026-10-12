/**
 * Development shortcuts: conveniences that make a fresh local checkout work without setup, but that no real deployment may have, because each
 * one trades a check for convenience:
 *
 *  - a signed-in user who belongs to no organization is placed in a shared "dev organization" (and the dev user is made its owner);
 *  - demo projects stand in for the database when it errors or a project is missing, and a canvas save for a missing project "succeeds";
 *  - any owner or admin can run Terraform when no organization allow-list is set;
 *  - an ID token whose signature could not be verified is accepted as a login.
 *
 * They were switched on by `NODE_ENV === 'development'` alone, so every `npm run dev` had them. They now also need an explicit opt-in:
 * CLOUDCRAFT_DEV_SHORTCUTS=1 in the environment (never set it on a server that anyone but you can reach). Without it the app behaves as it
 * does in production: no organization means "organization required", a database error is an error, and Terraform needs the allow-list.
 */
export function devShortcutsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['NODE_ENV'] === 'development' && env['CLOUDCRAFT_DEV_SHORTCUTS'] === '1';
}
