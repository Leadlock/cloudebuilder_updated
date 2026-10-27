# Integrate the approved CloudBuilder front page

This folder is a standalone static frontend, not a new application or backend. Its `index.html` and `assets/` contain the approved design, responsive layouts, light/dark themes, animated buttons, scroll entrances, expandable team tiles, scope details and accessible delivery modals.

## Task for the coding assistant in the main project

Integrate this frontend into the existing project and verify it works end to end. Implement the integration, not just a plan.

1. Read the main project's instructions and inspect its framework, router, public/static directories, existing authentication, backend endpoints and app start/dashboard routes. Use the project's existing tooling; do not create another app or replace its backend.
2. Make this page the public landing page at `/`, preserving its approved content, colors, styling, animations, responsive behavior and theme toggle. Preserve existing authenticated application functionality. Use the established public-versus-authenticated routing pattern; do not overwrite or delete an existing dashboard to free the root route.
3. Put these assets in the project's appropriate static/public directory and fix all URLs so they resolve at the deployed root. Adapt HTML to a framework component only if the existing project requires it. If converting to a component, implement interaction initialization and cleanup through that framework's lifecycle, avoid duplicate event handlers on remount, and apply the initial theme before paint. The original scripts expect a full document, so simply injecting scripts through component markup is insufficient.
4. Wire the header's **Start a deployment** and hero's **Deploy my application** actions to the actual existing app-start route. For a static integration, set `appEntryUrl` in `assets/app-config.js`. For a framework conversion, preserve equivalent behavior using its router. Let the existing backend handle login, sessions, redirects and authorization. Do not invent endpoints, add demo authentication, expose credentials or change backend business logic.
5. Keep local section anchors working, including `#solutions`, `#delivery-use-cases`, `#workflow`, `#teams`, `#scope`, `#value` and `#contact`. The homepage-only package does not include supporting pages: map **Catalogue** to an existing catalogue route if present, otherwise `#scope`; map **Team leverage** to an existing team-leverage route if present, otherwise `#teams`. Update active-nav detection for these destinations and any router integration. Keep external/new-tab link behavior intact.
6. Preserve the application's deployment configuration, API routing, security middleware and authentication. Do not let landing-page fallbacks swallow API or app requests. Respect its Content Security Policy by using existing nonce/hash or asset extraction conventions; do not disable CSP globally. No React, shadcn, Framer Motion or new UI dependencies are required for the provided static version.
7. Keep `cloudbuilder-theme` persistence, system-theme defaults, reduced-motion handling and focus/keyboard accessibility. Ensure the shared header is transparent over the hero and has a background after leaving it.
8. Run the project's relevant checks/build. Verify `/`, asset loading, mobile layout, light/dark switching and persistence, section anchors, nav animation, scroll reveals, delivery dialog open/close, team-tile expansion, scope toggles and the actual signed-out/signed-in app-entry flows. Verify existing backend/API routes still resolve. Do not claim live authentication was verified without running it.
9. Report the changed files, commands/checks performed and final app-entry route. If the backend or required route/configuration cannot be discovered, finish all independent integration work and identify the specific missing setting instead of silently guessing.

## Notes

- `assets/app-config.js` initially contains `appEntryUrl: null`; this intentionally keeps preview links until the main project's real route is discovered.
- No secrets belong in these public assets.
- Preserve the source folder as the design reference while integrating. Do not copy internal revenue pages or the demo sign-in screen; neither is included here.
- The design uses local CSS/JS and inline SVGs, with no external service dependency.
