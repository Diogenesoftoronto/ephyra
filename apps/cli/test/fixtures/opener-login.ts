// Run as a subprocess by opener.test.ts. Sign-in uses the CLI's real opener launch (xdg-open/open from PATH, which
// the test replaces with a long-lived fake) and an injected transport: no network.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitCodeFor, launchOpener } from "../../src/commands/cli";
import { withCliSignal } from "../../src/commands/interactive";
import { login } from "../../src/login";

const [mode, dir] = process.argv.slice(2) as ["approve" | "pending", string];
let polls = 0;
try {
  await withCliSignal(signal => login("https://fixture.invalid", {
    print() {}, env: { EPHYRA_CREDENTIALS: join(dir, "credentials.json") }, signal,
    sleep: (ms, s) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(ms, 50));
      s?.addEventListener("abort", () => { clearTimeout(timer); reject(s.reason); }, { once: true });
    }),
    open: url => launchOpener(url),
    fetch: (async () => {
      writeFileSync(join(dir, "polls"), String(++polls));
      return mode === "approve"
        ? Response.json({ token: "fixture-only", did: "did:plc:fixture", handle: null, approver: true })
        : new Response(null, { status: 428 });
    }) as unknown as typeof fetch,
  }));
  writeFileSync(join(dir, "outcome"), "signed-in");
} catch (error) {
  writeFileSync(join(dir, "outcome"), error instanceof Error ? error.name : "error");
  process.exitCode = exitCodeFor(error);
}
