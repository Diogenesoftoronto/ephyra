// A small stand-in for `parseAutonomy` / `renderAutonomy` (packages/policy). The console never imports policy;
// the fake only needs enough of the format to produce realistic warnings and proposals. Not a parser of record.
import { CheckpointModes, LandingModeNames, RiskLevels } from "../genui/catalog.local.ts";

const KEY = /^([a-z_]+):\s*(.*?)\s*(?:\s+#.*)?$/;
const KNOWN = ["mode", "checkpoints", "landing", "watch", "decide", "paths", "ui", "risk", "user_facing", "voxq_budget_usd"];

export function lintAutonomy(md: string): string[] {
  const out: string[] = [];
  let section = "";
  md.split("\n").forEach((line, i) => {
    const n = i + 1;
    if (/^##\s+area\s*:\s*$/.test(line)) { out.push(`line ${n}: invalid area heading`); return; }
    if (/^##\s/.test(line)) { section = /^##\s+(defaults|area:\s*.+)$/.test(line) ? line : ""; return; }
    const m = KEY.exec(line);
    if (!m || !section) return;
    const [, key, val = ""] = m;
    if (!KNOWN.includes(key!)) { out.push(`line ${n}: unknown key ${key}`); return; }
    if (key === "risk" && !(RiskLevels as readonly string[]).includes(val)) out.push(`line ${n}: invalid risk`);
    if (key === "mode" && val !== "shadow" && val !== "enforce") out.push(`line ${n}: invalid mode`);
    if (key === "watch" && !/^[1-9]\d*(s|m|h|d)$/.test(val)) out.push(`line ${n}: invalid watch`);
    if (key === "checkpoints" && val.split(/\s+/).some((p) => !/^[ABC]=(advisory|blocking)$/.test(p))) out.push(`line ${n}: invalid checkpoints`);
    const modes: readonly string[] = LandingModeNames;
    if (key === "landing" && val.split(/\s*,\s*|\s*\+\s*/).some((v) => !modes.includes(v))) out.push(`line ${n}: invalid landing`);
  });
  return out;
}

export type AreaForm = {
  name: string; paths: string[]; risk: (typeof RiskLevels)[number]; userFacing: boolean;
  checkpoints: Record<"A" | "B" | "C", (typeof CheckpointModes)[number]>;
  landing: string[]; watchSeconds: number; voxqMicrousd: number;
};

export function watchText(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function renderArea(a: AreaForm, prose = ""): string {
  const lines = [
    `## area: ${a.name}`, `paths: ${a.paths.join(", ")}`, `risk: ${a.risk}`, `user_facing: ${a.userFacing}`,
    `checkpoints: A=${a.checkpoints.A} B=${a.checkpoints.B} C=${a.checkpoints.C}`, `landing: ${a.landing.join(", ")}`,
    `watch: ${watchText(a.watchSeconds)}`,
    ...(a.voxqMicrousd > 0 ? [`voxq_budget_usd: ${(a.voxqMicrousd / 1_000_000).toFixed(0)}/month`] : []),
  ];
  return `${lines.join("\n")}\n${prose}`;
}

/** Replace the `## area: <name>` block (keeping its prose) or append a new one. */
export function upsertArea(md: string, a: AreaForm): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## area: ${a.name}`);
  if (start < 0) return `${md.replace(/\n*$/, "\n")}\n${renderArea(a)}`;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const prose = lines.slice(start + 1, end).filter((l) => !KEY.test(l) && l.trim() !== "").map((l) => `${l}\n`).join("");
  return [...lines.slice(0, start), ...renderArea(a, prose).replace(/\n$/, "").split("\n"), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function readAreaForm(md: string, name: string): Partial<AreaForm> | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## area: ${name}`);
  if (start < 0) return null;
  const out: Partial<AreaForm> = { name };
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = KEY.exec(l);
    if (!m) continue;
    if (m[1] === "paths") out.paths = m[2]!.split(/\s*,\s*/);
    if (m[1] === "risk") out.risk = m[2] as AreaForm["risk"];
    if (m[1] === "user_facing") out.userFacing = m[2] === "true";
  }
  return out;
}
