# @ephyra/policy

Pure rules for autonomy, backend thresholds, triage, proof, and post-landing watch. The package performs no I/O. Tests cover parser errors and overrides, the triage decision table, proof matrix, and watch boundaries. Candidate lists and signal kind must be supplied to triage; absent information takes a conservative path. Callers must enforce `autoLandAllowed` and critical forge-only landing, and provide actual human decisions and evidence. Integrations and production behavior are Unverified.

`renderAutonomy` renders defaults and areas; the parser’s fixed fallback and line-numbered warnings are not serialized. Area prose is normalized to a trailing newline.

## The application map (`sketch.ts`)

`sketchToArea(sketch, defaults)` and `areaToSketch(area, defaults?)` map an `AreaSketch` (plain-language intent, paths, risk, user-facing, and one of five autonomy levels) to and from a parsed autonomy `Area`. `applySketches(policy, sketches)` applies an edited map to a policy (the sketches are the complete set of mapped areas; `ui` globs and `decide` of areas that stay are kept; areas whose names the map cannot carry are untouched) and `sketchesOf(policy)` reads the map back. Every checkpoint is written explicitly, so an area reads the same under any defaults.

| Level | `mode` | A / B / C | `landing` | `watch` |
|---|---|---|---|---|
| Watch | shadow | blocking / blocking / blocking | trail_ref | inherited |
| Research | enforce | blocking / blocking / blocking | trail_ref | inherited |
| Propose | enforce | advisory / blocking / blocking | trail_ref | inherited |
| Patch | enforce | advisory / advisory / blocking | trail_ref | inherited |
| Auto-land | enforce | advisory / advisory / advisory | trail_ref, auto_land | 1h low, 2h medium, 4h high |

Reading an area back, `areaToSketch` picks the closest level for its effective settings (own values, then the defaults): auto_land landing with C advisory is Auto-land, `shadow` is Watch, otherwise the first blocking checkpoint among A and B decides Research or Propose, and the rest is Patch.

Limits worth knowing: a **critical** area never auto-lands (`autoLandAllowed`), so an Auto-land sketch on a critical area is applied as Patch and `sketchIssues` says so. The intent becomes the area's prose; a line that starts like a setting (`risk: …`, `paths matter`) has its first letter capitalised and a `## ` heading loses a `#`, so prose can never change the policy. Paths containing commas or newlines are refused. Property tests check that level, risk, paths, intent and user-facing survive sketch → area → markdown → parse → sketch. The levels are a mapping onto the parser's settings: whether a deployment really stops a trail at a level also depends on the callers enforcing the checkpoints and `autoLandAllowed`, which is Unverified here.


`evaluateProofBeforeC` checks automated evidence while retaining `awaitingHumanC` for the human-only high/critical
requirements. It never makes an absent replay, intent, UI result, study or visual approval pass. Final
`evaluateProof(..., {humanApprovedC:true})` is valid only after the caller has the actual named-human C decision.
