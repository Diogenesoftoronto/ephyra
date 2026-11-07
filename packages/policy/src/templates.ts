export const AUTONOMY_TEMPLATE = `# Autonomy policy

## defaults
mode: shadow                  # shadow | enforce
checkpoints: A=advisory B=advisory C=blocking
landing: trail_ref
watch: 2h
decide: judgement             # registry alias; thresholds follow the identity the response reports

## area: payments
paths: src/payments/**, src/checkout/**, intents/checkout-*.md
risk: critical
ui: webapp/src/checkout/**    # changes here need story proof (§8)
user_facing: true
Nothing lands here without a named human approving C. Patches must come with a
traffic-replay proof. Never touch schemas. Copy or flow changes need a real-respondent
voxq test before C; persona runs alone never count.

## area: cart
paths: src/cart/**
risk: medium
Agents may reproduce and patch. B is advisory; C is blocking unless the change is
under 40 lines, touches no exported types, and the regression probes pass — then
auto-land as trail_ref + devenv_live and watch for 2h.

## area: marketing-site
paths: apps/site/**
risk: low
ui: apps/site/src/**
user_facing: true
voxq_budget_usd: 60/month     # pre-approved by @diogenes for scheduled voxq probes
Loose edge. Auto-land to main with a 1h watch. Roll back on any new error fingerprint.
Copy changes carry a persona study; ask real people only about the signup path.
`;
export const THRESHOLDS_TEMPLATE = `"judgement-jev/jev-1.14":
  duplicate: 0.7
  regression: 0.7
  conflict: 0.6
  actionable: 0.4
  ignore: 0.8
  severity: 2.5
  confidence: 0.5
`;
