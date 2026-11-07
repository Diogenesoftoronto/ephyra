# Console

The console is an incomplete React/Vite application for the Ephyra control plane. It includes a
validated HTTP client and an early navigation shell. Overview, Usage and Personas have partial views;
Inbox and Workspace are placeholders and must not be used for decisions.

Run `bun run --filter @ephyra/console dev` for development, `build` for the app, `storybook` for the
component catalogue and `build-storybook` for a static build. Run `bun run --filter @ephyra/console
typecheck` and `bun test apps/console` for focused checks.

Verified: the app and Storybook build, and the client unit tests pass. Unverified: server integration,
authentication and browser behavior. The fake API, remaining screens, generated forms, complete
Storybook coverage and browser smoke tests are not implemented.
