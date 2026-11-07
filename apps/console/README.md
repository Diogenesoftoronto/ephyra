# Console

This package is an incomplete foundation for the Ephyra browser console. Its HTTP client validates
activity, usage, policy document and draft responses against core schemas. It accepts a session token
and retains the operation key when a write has an ambiguous outcome.

Run `bun run --filter @ephyra/console typecheck` and `bun test apps/console` to check the client.

Unverified: integration with the server, authentication, and all browser behavior. The SPA, fake API,
Storybook and screens have not yet been implemented.
