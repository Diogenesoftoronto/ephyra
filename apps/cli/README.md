# Ephyra CLI

Run `bun run src/main.ts` or install the workspace binary as `ephyra`. Set `EPHYRA_URL`, `EPHYRA_API_TOKEN`, and `EPHYRA_PRINCIPAL` for API commands. `init --remote origin` creates shadow-mode templates and configures git refspecs; `--force` replaces templates. `--json` emits JSON. Comment and kill require `-m` text. In the inbox, `q` exits and r/c/x accept a one-line note.

Verified: offline fake-fetch client, reducer and property checks, template/refspec idempotence in a temporary git repository, 80x24 text snapshot, and OpenTUI native test renderer initialization on Bun 1.4.4. Textbook story definitions cover empty, waiting, shadow, spend and error states. OpenTUI 0.5.x matches Textbook 0.2.0.

Unverified: a real server, interactive terminal behavior and Textbook story rendering. The inbox opens HTTP(S) landing URLs with the system opener and displays the evidence index. Landing is offered only for ready trails and enforced by the server. Set `EPHYRA_ANSI=1` to use the ANSI terminal. Ambiguous writes are reported without automatic retry; the server must implement the Idempotency-Key contract for durable reconciliation. HTTP errors deliberately omit response bodies to avoid exposing secrets.

Exit codes: 0 for success, 1 for usage, configuration, or API errors.

The inbox refreshes every 30 seconds, and stale decisions show a 409 message with their optimistic update rolled back. `show` accepts a full ID or an exact `T-xxxxxx` short ID and rejects collisions. Sapling synchronization is not implemented.
