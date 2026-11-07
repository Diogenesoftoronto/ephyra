import { VERSION } from "./compose.ts";
import { composeApplication } from "./application.ts";
import { readConfig } from "./config.ts";

const config = readConfig(process.env);
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
