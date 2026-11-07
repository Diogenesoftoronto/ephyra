import type { AutonomyPolicy, Area } from "./autonomy";
import type { Checkpoint } from "@ephyra/core";
function glob(pattern: string, path: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(re + "$").test(path);
}
export function areaFor(policy: AutonomyPolicy, paths: string[]): Area {
  let best = policy.fallback;
  let score = -1;
  for (const area of policy.areas)
    for (const pattern of area.paths)
      if (paths.some((path) => glob(pattern, path))) {
        const s = pattern.replace(/[*?]/g, "").length;
        if (s > score) {
          score = s;
          best = area;
        }
      }
  return best;
}
export function checkpointMode(
  policy: AutonomyPolicy,
  area: Area,
  checkpoint: Checkpoint,
): "blocking" | "advisory" {
  return (area.mode ?? policy.defaults.mode) === "shadow"
    ? "blocking"
    : (area.overrides[checkpoint] ?? policy.defaults.checkpoints[checkpoint]);
}
