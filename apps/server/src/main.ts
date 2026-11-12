import { knownSecrets, VERSION } from "./compose.ts";
import { installSelfReporter, reportSelfError, SelfReporter } from "./self-telemetry.ts";
import { releaseRevision } from "./release.ts";
import { composeApplication } from "./application.ts";
import { readConfig } from "./config.ts";

const config = readConfig(process.env);
if (config.EPHYRA_SELF_OTLP_ENDPOINT && config.EPHYRA_SELF_OTLP_TOKEN) {
  const reporter = new SelfReporter({
    endpoint: config.EPHYRA_SELF_OTLP_ENDPOINT, token: config.EPHYRA_SELF_OTLP_TOKEN,
    service: config.EPHYRA_SELF_SERVICE, environment: config.EPHYRA_SELF_ENVIRONMENT,
    version: releaseRevision() ?? VERSION, sourceRoot: process.cwd(), secrets: knownSecrets(config),
  });
  installSelfReporter(reporter);
  // A crash still crashes, as it would without a listener: report first, wait briefly for delivery, then exit.
  const crash = (source: string) => async (reason: unknown) => {
    reportSelfError(reason, source);
    await Promise.race([reporter.flush(), Bun.sleep(2_000)]);
    console.error(reason);
    process.exit(1);
  };
  process.on("unhandledRejection", crash("process:unhandledRejection"));
  process.on("uncaughtException", crash("process:uncaughtException"));
}
const composed = await composeApplication(config);
const server = Bun.serve({ hostname: "0.0.0.0", port: config.PORT, fetch: composed.app.fetch });
console.log(JSON.stringify({ msg: "ephyra server listening", port: server.port, mode: composed.mode, version: VERSION }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    server.stop();
    await composed.close();
    process.exit(0);
  });
}
