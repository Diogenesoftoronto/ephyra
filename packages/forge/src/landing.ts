import type { ForgeAdapter, LandingMode } from "@ephyra/core";
export function landingFor(
  modes: LandingMode[],
  adapters: ForgeAdapter[],
): Map<LandingMode, ForgeAdapter> {
  const result = new Map<LandingMode, ForgeAdapter>();
  for (const mode of modes) {
    if (mode === "devenv_live")
      throw new Error("devenv_live is handled by the runner");
    const name =
      mode === "radicle_patch"
        ? "radicle"
        : mode === "tangled_pull"
          ? "tangled"
          : "plain-git";
    const adapter = adapters.find((a) => a.name === name);
    if (!adapter) throw new Error(`no adapter for ${mode}`);
    result.set(mode, adapter);
  }
  return result;
}
