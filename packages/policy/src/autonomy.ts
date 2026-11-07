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
    const match = /^([a-z_]+):\s*(.*?)\s*(?:\s+#.*)?$/.exec(line);
    if (!match) {
      if (/^[a-z_]+\s*:/.test(line))
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
      } else if (key === "watch") policy.defaults.watch = val;
      else if (key === "decide") {
        if (!val) return error();
        policy.defaults.decide = val;
      } else policy.warnings.push(`line ${index + 1}: unknown key ${key}`);
    } else if (section === "area" && area) {
      if (key === "paths" || key === "ui")
        area[key] = val.split(/\s*,\s*/).filter(Boolean);
      else if (key === "risk") {
        if (!["low", "medium", "high", "critical"].includes(val))
          return error();
        area.risk = val as Risk;
      } else if (key === "user_facing") {
        if (val !== "true" && val !== "false") return error();
        area.user_facing = val === "true";
      } else if (key === "voxq_budget_usd") area.voxq_budget_usd = val;
      else if (key === "mode") {
        if (val !== "shadow" && val !== "enforce") return error();
        area.mode = val;
      } else if (key === "checkpoints") {
        for (const part of val.split(/\s+/)) {
          const m = /^([ABC])=(advisory|blocking)$/.exec(part);
          if (!m) return error();
          area.overrides[m[1] as Checkpoint] = m[2] as "advisory" | "blocking";
        }
      } else {
        policy.warnings.push(`line ${index + 1}: unknown key ${key}`);
        area.prose += raw;
      }
    }
  });
  return policy;
}
