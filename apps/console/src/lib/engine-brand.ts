/** Recognize the recorded agent harness, never guess it from a model name or execution host. */
const BRANDS = {
  amp: { id: "amp", name: "Amp" },
  codex: { id: "codex", name: "Codex" },
  "claude-code": { id: "claude", name: "Claude Code" },
} as const;

export function engineBrand(engine?: string | null) {
  const harness = engine?.split("/", 1)[0];
  if (!harness || !Object.hasOwn(BRANDS, harness)) return null;
  return BRANDS[harness as keyof typeof BRANDS];
}
