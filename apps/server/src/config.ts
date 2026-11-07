import { z } from "zod";

const optional = z.string().min(1).optional();

const Config = z.object({
  EPHYRA_API_TOKEN: z.string().min(16),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Convex (durable state). Unset ⇒ in-memory mode (dev only; state is lost on restart).
  CONVEX_URL: z.string().url().optional(),
  EPHYRA_CONVEX_SECRET: optional,

  // The repository this deployment drives.
  EPHYRA_REPO_ID: z.string().min(1).default("default"),
  EPHYRA_REPO_URL: optional,
  EPHYRA_BASE_REF: z.string().default("refs/heads/main"),
  EPHYRA_FORGE: z.enum(["plain", "radicle", "tangled"]).default("plain"),
  EPHYRA_DATA_DIR: z.string().default("/data"),

  // Policy files (optional; shadow-mode templates otherwise).
  EPHYRA_AUTONOMY_FILE: optional,
  EPHYRA_THRESHOLDS_FILE: optional,

  // System One backends. Each is optional; without a decide backend triage routes every signal to a human.
  EPHYRA_EXTRACT: z.enum(["parser", "workers-ai", "none"]).default("parser"),
  EPHYRA_DECIDE: z.enum(["typesafe", "systemone", "none"]).default("none"),
  TYPESAFE_API_KEY: optional,
  TYPESAFE_MODEL: z.string().default("jev-1.14"),
  EPHYRA_SYSTEMONE_URL: optional,
  EPHYRA_SYSTEMONE_KEY: optional,
  EPHYRA_SYSTEMONE_MODEL: optional,
  CLOUDFLARE_ACCOUNT_ID: optional,
  CLOUDFLARE_AI_API_TOKEN: optional,

  // Agents. `none` keeps trails at the human checkpoints; `claude-code` / `codex` need the CLI in the image.
  EPHYRA_AGENT: z.enum(["none", "claude-code", "codex"]).default("none"),
  EPHYRA_AGENT_MODEL: optional,
  EPHYRA_STEP_TIMEOUT_S: z.coerce.number().int().positive().default(1800),
  EPHYRA_WATCH_EVERY_S: z.coerce.number().int().positive().default(300),
});
export type Config = z.infer<typeof Config>;

export function readConfig(env: Record<string, string | undefined>): Config {
  const config = Config.parse(env);
  if (config.CONVEX_URL && !config.EPHYRA_CONVEX_SECRET) throw new Error("CONVEX_URL is set but EPHYRA_CONVEX_SECRET is not");
  if (config.EPHYRA_DECIDE === "typesafe" && !config.TYPESAFE_API_KEY) throw new Error("EPHYRA_DECIDE=typesafe needs TYPESAFE_API_KEY");
  if (config.EPHYRA_DECIDE === "systemone" && !(config.EPHYRA_SYSTEMONE_URL && config.EPHYRA_SYSTEMONE_MODEL)) {
    throw new Error("EPHYRA_DECIDE=systemone needs EPHYRA_SYSTEMONE_URL and EPHYRA_SYSTEMONE_MODEL");
  }
  if (config.EPHYRA_EXTRACT === "workers-ai" && !(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_AI_API_TOKEN)) {
    throw new Error("EPHYRA_EXTRACT=workers-ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN");
  }
  return config;
}
