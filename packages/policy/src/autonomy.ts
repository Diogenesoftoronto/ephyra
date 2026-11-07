import type { Checkpoint, LandingMode, Risk } from "@ephyra/core";
export type Area = {
  name: string;
  paths: string[];
  ui: string[];
  risk: Risk;
  user_facing: boolean;
  voxq_budget_usd?: string;
  overrides: Partial<Record<Checkpoint, "advisory" | "blocking">>;
  prose: string;
  mode?: "shadow" | "enforce";
  landing?: LandingMode[];
  watch?: string;
  decide?: string;
};
export type AutonomyPolicy = {
  defaults: {
    mode: "shadow" | "enforce";
    checkpoints: Record<Checkpoint, "advisory" | "blocking">;
    landing: LandingMode[];
    watch: string;
    decide: string;
  };
  areas: Area[];
  fallback: Area;
  warnings: string[];
};
export function parseAutonomy(md: string): AutonomyPolicy {
  const fallback: Area = {
    name: "fallback",
    paths: [],
    ui: [],
    risk: "high",
    user_facing: false,
    overrides: {},
    prose: "",
  };
  const policy: AutonomyPolicy = {
    defaults: {
      mode: "shadow",
      checkpoints: { A: "blocking", B: "blocking", C: "blocking" },
      landing: ["trail_ref"],
      watch: "2h",
      decide: "judgement",
    },
    areas: [],
    fallback,
    warnings: [],
  };
  let section = "";
  let area: Area | undefined;
  const lines = md.split(/(?<=\n)/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r?\n$/, "");
    const heading = /^##\s+(defaults|area:\s*(.+))\s*$/.exec(line);
    if (heading) {
      section = heading[1]!.startsWith("area:") ? "area" : "defaults";
      if (section === "area") {
        area = {
          ...fallback,
          name: heading[2]!.trim(),
          paths: [],
          ui: [],
          overrides: {},
          prose: "",
        };
        policy.areas.push(area);
      }
      return;
    }
    if (/^##\s/.test(line)) {
      if (/^##\s+area\s*:/.test(line))
        throw new Error(`line ${index + 1}: invalid area heading`);
      section = "";
      area = undefined;
      return;
    }
    const match = /^([a-z_]+):\s*(.*?)\s*(?:\s+#.*)?$/.exec(line);
    if (!match) {
      if (
        /^\s*(?:mode|checkpoints|landing|watch|decide|paths|ui|risk|user_facing|voxq_budget_usd)\s*(?:=|:|\s)/.test(
          line,
        )
      )
        throw new Error(`line ${index + 1}: malformed key`);
      if (section === "area" && area) area.prose += raw;
      return;
    }
    const [, key, val = ""] = match;
    const error = () => {
      throw new Error(`line ${index + 1}: invalid ${key}`);
    };
    if (section === "defaults") {
      if (key === "mode") {
        if (val !== "shadow" && val !== "enforce") return error();
        policy.defaults.mode = val;
      } else if (key === "checkpoints") {
        for (const part of val.split(/\s+/)) {
          const m = /^([ABC])=(advisory|blocking)$/.exec(part);
          if (!m) return error();
          policy.defaults.checkpoints[m[1] as Checkpoint] = m[2] as
            "advisory" | "blocking";
        }
      } else if (key === "landing") {
        const values = val.split(/\s*,\s*|\s*\+\s*/);
        if (
          values.some(
            (v) =>
              ![
                "trail_ref",
                "devenv_live",
                "radicle_patch",
                "tangled_pull",
                "auto_land",
              ].includes(v),
          )
        )
          return error();
        policy.defaults.landing = values as LandingMode[];
      } else if (key === "watch") {
        if (!/^[1-9]\d*(s|m|h|d)$/.test(val)) return error();
        policy.defaults.watch = val;
      } else if (key === "decide") {
        if (!val) return error();
        policy.defaults.decide = val;
      } else policy.warnings.push(`line ${index + 1}: unknown key ${key}`);
    } else if (section === "area" && area) {
      if (key === "paths" || key === "ui") {
        const values = val.split(/\s*,\s*/);
        if (values.some((value) => !value)) return error();
        area[key] = values;
      } else if (key === "risk") {
        if (!["low", "medium", "high", "critical"].includes(val))
          return error();
        area.risk = val as Risk;
      } else if (key === "user_facing") {
        if (val !== "true" && val !== "false") return error();
        area.user_facing = val === "true";
      } else if (key === "voxq_budget_usd") {
        if (!/^\d+(?:\.\d+)?\/month$/.test(val)) return error();
        area.voxq_budget_usd = val;
      } else if (key === "mode") {
        if (val !== "shadow" && val !== "enforce") return error();
        area.mode = val;
      } else if (key === "checkpoints") {
        for (const part of val.split(/\s+/)) {
          const m = /^([ABC])=(advisory|blocking)$/.exec(part);
          if (!m) return error();
          area.overrides[m[1] as Checkpoint] = m[2] as "advisory" | "blocking";
        }
      } else if (key === "landing") {
        const values = val.split(/\s*,\s*|\s*\+\s*/);
        if (
          values.some(
            (v) =>
              ![
                "trail_ref",
                "devenv_live",
                "radicle_patch",
                "tangled_pull",
                "auto_land",
              ].includes(v),
          )
        )
          return error();
        area.landing = values as LandingMode[];
      } else if (key === "watch") {
        if (!/^[1-9]\d*(s|m|h|d)$/.test(val)) return error();
        area.watch = val;
      } else if (key === "decide") {
        if (!val) return error();
        area.decide = val;
      } else {
        policy.warnings.push(`line ${index + 1}: unknown key ${key}`);
        area.prose += raw;
      }
    }
  });
  return policy;
}

/** Render a parser-representable policy as autonomy markdown. */
export function renderAutonomy(policy: AutonomyPolicy): string {
  const checkpoints = (values: Partial<Record<Checkpoint, "advisory" | "blocking">>) =>
    (["A", "B", "C"] as const).filter((key) => values[key]).map((key) => `${key}=${values[key]}`).join(" ");
  const d = policy.defaults;
  let result = `## defaults\nmode: ${d.mode}\ncheckpoints: ${checkpoints(d.checkpoints)}\n`;
  result += `landing: ${d.landing.join(", ")}\nwatch: ${d.watch}\ndecide: ${d.decide}\n`;
  for (const area of policy.areas) {
    result += `## area: ${area.name}\n`;
    if (area.paths.length) result += `paths: ${area.paths.join(", ")}\n`;
    if (area.ui.length) result += `ui: ${area.ui.join(", ")}\n`;
    result += `risk: ${area.risk}\nuser_facing: ${area.user_facing}\n`;
    if (area.voxq_budget_usd !== undefined) result += `voxq_budget_usd: ${area.voxq_budget_usd}\n`;
    if (area.mode !== undefined) result += `mode: ${area.mode}\n`;
    if (Object.keys(area.overrides).length) result += `checkpoints: ${checkpoints(area.overrides)}\n`;
    if (area.landing !== undefined) result += `landing: ${area.landing.join(", ")}\n`;
    if (area.watch !== undefined) result += `watch: ${area.watch}\n`;
    if (area.decide !== undefined) result += `decide: ${area.decide}\n`;
    result += area.prose;
    if (area.prose && !area.prose.endsWith("\n")) result += "\n";
  }
  return result;
}
