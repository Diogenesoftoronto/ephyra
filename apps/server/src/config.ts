import { join } from "node:path";
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

  // Sign in with Not Organic. Enabled when EPHYRA_PUBLIC_ORIGIN and EPHYRA_SESSION_KEY are set; then changing
  // trails needs a signed-in account listed in EPHYRA_APPROVER_DIDS.
  EPHYRA_PUBLIC_ORIGIN: z.string().url().optional(),
  EPHYRA_SESSION_KEY: optional,
  EPHYRA_APPROVER_DIDS: z.string().default(""),
  NOTORGANIC_ISSUER: z.string().url().default("https://api.notorganic.info"),
  NOTORGANIC_AUTHORIZATION_URL: z.string().url().default("https://id.notorganic.info/authorize"),
  /** Product id the gateway binds Ephyra's client origin to. */
  NOTORGANIC_PRODUCT: z.string().default("notorganic"),
  /** Whose wallet pays for hosted models (defaults to the first approver). */
  EPHYRA_BILLING_DID: optional,

  // Policy files (optional; shadow-mode templates otherwise).
  EPHYRA_AUTONOMY_FILE: optional,
  EPHYRA_THRESHOLDS_FILE: optional,

  // System One backends. Each is optional; without a decide backend triage routes every signal to a human.
  EPHYRA_EXTRACT: z.enum(["parser", "workers-ai", "notorganic", "none"]).default("parser"),
  EPHYRA_DECIDE: z.enum(["typesafe", "systemone", "notorganic", "none"]).default("none"),
  TYPESAFE_API_KEY: optional,
  TYPESAFE_MODEL: z.string().default("jev-1.14"),
  EPHYRA_SYSTEMONE_URL: optional,
  EPHYRA_SYSTEMONE_KEY: optional,
  EPHYRA_SYSTEMONE_MODEL: optional,
  CLOUDFLARE_ACCOUNT_ID: optional,
  CLOUDFLARE_AI_API_TOKEN: optional,

  // Velum, the policy scribe in the web console. `none` leaves the console's chat answering that Velum is not configured.
  // notorganic is paid from the billing account (needs sign-in); anthropic and openai are bring-your-own-key.
  EPHYRA_DRAFT: z.enum(["none", "notorganic", "anthropic", "openai", "ampersand", "fake"]).default("none"),
  EPHYRA_DRAFT_MODEL: optional,
  EPHYRA_DRAFT_ANTHROPIC_API_KEY: optional,
  EPHYRA_DRAFT_OPENAI_API_KEY: optional,
  EPHYRA_HUMANS_API_KEY: optional,
  EPHYRA_TUTOR: z.enum(["none", "notorganic", "ampersand"]).default("none"),
  EPHYRA_TUTOR_MAX_COST_MICROUSD: z.coerce.number().int().positive().max(100_000).default(100_000),
  // Speech remains optional. Explicit models and voice prevent a silent provider/voice fallback.
  EPHYRA_VOICE: z.enum(["none", "notorganic", "compatible"]).default("none"),
  EPHYRA_VOICE_URL: z.string().url().optional(),
  EPHYRA_VOICE_API_KEY: optional,
  EPHYRA_VOICE_STT_MODEL: optional,
  EPHYRA_VOICE_TTS_MODEL: optional,
  EPHYRA_VOICE_NAME: optional,
  EPHYRA_VOICE_MAX_COST_MICROUSD: z.coerce.number().int().positive().max(10_000_000).default(100_000),
  /** Built web console, served at /app/ when the directory exists. */
  EPHYRA_CONSOLE_DIR: z.string().default(join(import.meta.dir, "../../console/dist")),

  // Agents. `none` keeps trails at the human checkpoints; `claude-code` / `codex` need the CLI in the image.
  EPHYRA_AGENT: z.enum(["none", "claude-code", "codex", "amp"]).default("none"),
  /** amp agent: where turns run (local CLI, Amp orb, or an `amp --no-tui` runner). Needs AMP_API_KEY for orb/runner. */
  EPHYRA_AMP_EXECUTOR: z.enum(["local", "orb", "runner"]).default("local"),
  EPHYRA_AMP_PROJECT: optional,
  EPHYRA_AMP_RUNNER_ID: optional,
  EPHYRA_AMP_MODE: z.enum(["low", "medium", "high", "ultra"]).default("medium"),
  EPHYRA_AGENT_MODEL: optional,
  EPHYRA_STEP_TIMEOUT_S: z.coerce.number().int().positive().default(1800),
  EPHYRA_WATCH_EVERY_S: z.coerce.number().int().positive().default(300),
  /** Optional self-hosted evidence source. Personal workspaces receive their own authorized binding. */
  EPHYRA_TRACTION_ORIGIN: optional,
  EPHYRA_TRACTION_TOKEN: optional,
  EPHYRA_TRACTION_PROJECTS: optional,
});
export type Config = z.infer<typeof Config>;

export function readConfig(env: Record<string, string | undefined>): Config {
  const config = Config.parse(env);
  if (config.EPHYRA_TRACTION_ORIGIN || config.EPHYRA_TRACTION_TOKEN || config.EPHYRA_TRACTION_PROJECTS) {
    if (!(config.EPHYRA_TRACTION_ORIGIN && config.EPHYRA_TRACTION_TOKEN && config.EPHYRA_TRACTION_PROJECTS))
      throw new Error("Traction needs EPHYRA_TRACTION_ORIGIN, EPHYRA_TRACTION_TOKEN and EPHYRA_TRACTION_PROJECTS");
    const url = new URL(config.EPHYRA_TRACTION_ORIGIN);
    if (url.protocol !== "https:" || url.origin !== config.EPHYRA_TRACTION_ORIGIN)
      throw new Error("Traction requires a bare HTTPS origin without credentials, path, query or fragment");
    if (config.EPHYRA_TRACTION_PROJECTS.split(",").some((id) => !/^[a-zA-Z0-9._-]{1,200}$/.test(id.trim())))
      throw new Error("Traction project identifiers must be a comma-separated allowlist");
  }
  if (config.CONVEX_URL && !config.EPHYRA_CONVEX_SECRET) throw new Error("CONVEX_URL is set but EPHYRA_CONVEX_SECRET is not");
  if (config.EPHYRA_DECIDE === "typesafe" && !config.TYPESAFE_API_KEY) throw new Error("EPHYRA_DECIDE=typesafe needs TYPESAFE_API_KEY");
  if (config.EPHYRA_DECIDE === "systemone" && !(config.EPHYRA_SYSTEMONE_URL && config.EPHYRA_SYSTEMONE_MODEL)) {
    throw new Error("EPHYRA_DECIDE=systemone needs EPHYRA_SYSTEMONE_URL and EPHYRA_SYSTEMONE_MODEL");
  }
  if (config.EPHYRA_EXTRACT === "workers-ai" && !(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_AI_API_TOKEN)) {
    throw new Error("EPHYRA_EXTRACT=workers-ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN");
  }
  if (config.EPHYRA_AGENT === "amp" && config.EPHYRA_AMP_EXECUTOR === "runner" && !config.EPHYRA_AMP_RUNNER_ID) {
    throw new Error("EPHYRA_AMP_EXECUTOR=runner needs EPHYRA_AMP_RUNNER_ID");
  }
  const signIn = Boolean(config.EPHYRA_PUBLIC_ORIGIN || config.EPHYRA_SESSION_KEY);
  if (signIn && !(config.EPHYRA_PUBLIC_ORIGIN && config.EPHYRA_SESSION_KEY)) {
    throw new Error("Not Organic sign-in needs both EPHYRA_PUBLIC_ORIGIN and EPHYRA_SESSION_KEY");
  }
  if (config.EPHYRA_PUBLIC_ORIGIN && new URL(config.EPHYRA_PUBLIC_ORIGIN).origin !== config.EPHYRA_PUBLIC_ORIGIN) {
    throw new Error("EPHYRA_PUBLIC_ORIGIN must be a bare origin (scheme://host[:port]) with no path");
  }
  if (config.EPHYRA_DRAFT === "anthropic" && !config.EPHYRA_DRAFT_ANTHROPIC_API_KEY) {
    throw new Error("EPHYRA_DRAFT=anthropic needs EPHYRA_DRAFT_ANTHROPIC_API_KEY");
  }
  if (config.EPHYRA_DRAFT === "openai" && !config.EPHYRA_DRAFT_OPENAI_API_KEY) throw new Error("EPHYRA_DRAFT=openai needs EPHYRA_DRAFT_OPENAI_API_KEY");
  if ((config.EPHYRA_DRAFT === "ampersand" || config.EPHYRA_TUTOR === "ampersand") && !config.EPHYRA_HUMANS_API_KEY)
    throw new Error("Ampersand needs EPHYRA_HUMANS_API_KEY");
  if (config.EPHYRA_DRAFT === "ampersand" && config.EPHYRA_DRAFT_MODEL && config.EPHYRA_DRAFT_MODEL !== "ampersand-v0.1")
    throw new Error("The Ampersand adapter supports ampersand-v0.1; select &Tutor with EPHYRA_TUTOR");
  if (config.EPHYRA_VOICE !== "none" && !(config.EPHYRA_VOICE_STT_MODEL && config.EPHYRA_VOICE_TTS_MODEL && config.EPHYRA_VOICE_NAME))
    throw new Error("Voice needs EPHYRA_VOICE_STT_MODEL, EPHYRA_VOICE_TTS_MODEL and EPHYRA_VOICE_NAME");
  if (config.EPHYRA_VOICE === "compatible" && !config.EPHYRA_VOICE_URL)
    throw new Error("EPHYRA_VOICE=compatible needs EPHYRA_VOICE_URL (including /v1)");
  if (config.EPHYRA_VOICE_URL) {
    const url = new URL(config.EPHYRA_VOICE_URL);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("EPHYRA_VOICE_URL must be an HTTP(S) base URL without credentials, query or fragment");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Remote voice services require HTTPS");
  }
  const hosted = config.EPHYRA_DECIDE === "notorganic" || config.EPHYRA_EXTRACT === "notorganic" || config.EPHYRA_DRAFT === "notorganic"
    || config.EPHYRA_VOICE === "notorganic" || config.EPHYRA_TUTOR === "notorganic";
  if (hosted && !signIn) throw new Error("hosted Not Organic models need sign-in configured (EPHYRA_PUBLIC_ORIGIN, EPHYRA_SESSION_KEY)");
  if (hosted && !(config.EPHYRA_BILLING_DID || approverDids(config).length)) {
    throw new Error("hosted Not Organic models need EPHYRA_BILLING_DID or EPHYRA_APPROVER_DIDS");
  }
  return config;
}

export function approverDids(config: Config): string[] {
  return config.EPHYRA_APPROVER_DIDS.split(",").map((d) => d.trim()).filter(Boolean);
}
