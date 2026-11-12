---
title: Proof requirements
summary: What has to exist before a repair can land, how it scales with risk, and how to teach Ephyra to run your own checks.
---

"The tests pass" is a weak reason to merge an agent's patch. The tests passed before, too, while the bug was live. Ephyra asks for evidence that this change fixes this problem, and asks for more as the stakes rise.

## What every repair needs

- **A reproduction** that fails before the patch and passes after it.
- **Test results** from the repository's suite.
- **The scope of the diff**: which files changed and by how much.

## What risk and scope add

| When the change is | It also needs |
|---|---|
| Any UI change | Story rendering and interaction results. |
| Medium, high or critical | Executed regression and intent probes, plus a bug review. |
| A non-low UI change | Visual differences, and named approval of the changed visuals. |
| Non-low and user-facing | A synthetic persona study. |
| High or critical | A traffic replay, and a named person approving checkpoint C. |
| A high or critical UI change | A recording, or a terminal recording. |
| High or critical and user-facing | A completed study with real respondents. |
| Critical | Manual landing. Automatic and live landing are forbidden. |

Risk and "user-facing" come from the [area](./policy) the change touches.

## Missing is a blocker

If a required item did not run, the bundle lists it as missing and the quest does not land. A check Ephyra cannot reach is reported as unavailable. Nothing is filled in to make the list look complete.

So when a quest stops at proof, read the missing items first. Usually the fix is configuration: a reporter that is not declared, a probe type with no adapter, a study source that is not granted.

> [!NOTE]
> Script intent probes are supported. Other designed probe kinds (HTTP, trace, agent) need execution adapters that are not shipped. A requirement that depends on one stays a blocker until an adapter exists.

## Teach Ephyra to run your checks

UI and replay evidence comes from commands in your repository. Declare them in `.ephyra/proof.json` on your base branch:

```json
{
  "schema": 1,
  "commands": [
    {
      "id": "stories",
      "command": ["bun", "run", "proof:stories"],
      "protectedPaths": ["package.json", "bun.lock", "proof/**"],
      "kinds": ["story_render", "story_interaction"]
    }
  ]
}
```

`protectedPaths` must cover the whole harness and its dependency closure. If a candidate patch modifies anything inside it, the verifier is invalidated, because a patch must not be able to edit the check that judges it.

Adding this file does not produce evidence. The command has to run and report.

<details>
<summary>The reporter's response contract</summary>

The command writes JSON to stdout and exits successfully only after its checks complete. It reads what it is bound to from `EPHYRA_PROOF_TRAIL`, `EPHYRA_PROOF_REV`, `EPHYRA_PROOF_BASE` and `EPHYRA_PROOF_HEAD`. Revision is a number.

```json
{
  "schema": 1,
  "trailId": "EXACT_TRAIL_UUID",
  "rev": 1,
  "base": "EXACT_BASE_COMMIT",
  "head": "EXACT_HEAD_COMMIT",
  "items": [
    { "kind": "story_render", "surface": "web", "stories": ["ACTUAL_STORY_ID"], "failed": [], "uncovered": [] },
    { "kind": "story_interaction", "surface": "web", "stories": ["ACTUAL_STORY_ID"], "failed": [], "log": "ACTUAL_EXECUTION_LOG" }
  ]
}
```

This shows the shape, not a passing run. Fill story IDs, failures, coverage and logs from what the reporter actually observed, and emit only the evidence kinds granted to that command. Repository reporters cannot supply persona or human-study provenance; those arrive as [study evidence](./study-evidence).

</details>

## What a proof bundle does and does not attest

The bundle is bound to the quest, its revision, the base and head commits, and a SHA-256 digest of its exact contents. An approval at C is bound to that digest, so a bundle cannot be swapped after you read it.

The digest proves *which* bundle you approved. It does not independently prove that the commands inside it ran; that rests on the runner and the protected harness. [The trust model](./trust) says more about where each guarantee comes from.

## Next

- [Bring in persona and respondent studies](./study-evidence)
- [What you look at when you review C](./reviewing#c-does-this-exact-revision-fix-it)
