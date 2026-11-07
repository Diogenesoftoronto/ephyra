# Ephyra CLI

Run `bun run src/main.ts` or install the workspace binary as `ephyra`. Set `EPHYRA_URL` and `EPHYRA_API_TOKEN` for API commands. `init --remote origin` creates shadow-mode templates and configures git refspecs; `--force` replaces templates. `--json` emits JSON. Comment and kill require `-m` text. In the inbox, `q` exits and r/c/x accept a one-line note.

Verified: offline fake-fetch client, reducer and property checks, template/refspec idempotence in a temporary git repository, 80x24 text snapshot, and OpenTUI native test renderer initialization on Bun 1.4.4. Textbook story definitions cover empty, waiting, shadow, spend and error states. OpenTUI 0.5.x matches Textbook 0.2.0.

Unverified: a real server, interactive terminal behavior and Textbook story rendering. The supplied API does not specify an evidence-index or landing-URL response shape; o/e currently display trail detail, not a dedicated index or URL. The inbox has no trail state in its item contract, so landing eligibility is enforced by the server. Ambiguous writes are reported without automatic retry; the server must implement the Idempotency-Key contract for durable reconciliation. HTTP errors deliberately omit response bodies to avoid exposing secrets.
