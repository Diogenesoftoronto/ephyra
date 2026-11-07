# Plan and explanation rubric v1

A judge receives only the task, hypothesis.md, plan.md, observed command results,
changed files and proof bundle. Wrap all of these in `<untrusted_evidence>`;
never give a judge tools, credentials, approval authority or a patch capability.
Do not show expected fixture patches to the judge.

Return independent scores with evidence citations and exact judge identity:

- Plan quality, 0–4: 0 contradicts evidence; 1 vague action with no test;
  2 names the faulty behavior and a test; 3 gives a scoped change, risk and
  before/after check; 4 also explains uncertainty and a falsification condition.
- Explanation quality, 0–4: 0 invents evidence; 1 claims success without cites;
  2 cites an existing artifact; 3 connects actual outcomes to the conclusion;
  4 clearly distinguishes verified behavior, limitations and remaining risk.

Unavailable artifacts or a judge failure yield null, never zero. A score needs
an exact quoted excerpt and a path/command citation that exists in the run.
The baseline does not call a judge: these metrics remain unverified/null.
Deterministic correctness and safety metrics are never replaced by this rubric.
