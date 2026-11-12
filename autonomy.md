# Autonomy policy

Ephyra's own policy for Ephyra. The loop may go as far as the hard limits allow: low and medium risk areas
land by themselves behind a watch, high risk areas need a named human at C, and the code that enforces these
limits is critical, so it never lands by itself and nothing here may widen what the loop is allowed to do.

## defaults
mode: enforce
checkpoints: A=advisory B=advisory C=advisory
landing: trail_ref
watch: 2h
decide: judgement

## area: site
paths: site/**, apps/web/**
risk: low
user_facing: true
landing: auto_land
watch: 1h
The public site and blog. Land by itself behind a 1h watch; roll back on any new error fingerprint.

## area: docs
paths: README.md, PRODUCT.md, apps/*/README.md, packages/*/README.md, research/**, personas/**
risk: low
user_facing: false
landing: auto_land
watch: 1h
Words that describe the code. Keep them true to what the code does; never claim a check that did not run.

## area: evals
paths: apps/evals/**
risk: low
user_facing: false
landing: auto_land
watch: 1h
Offline evaluation. Never point it at live providers by default.

## area: console
paths: apps/console/**
risk: medium
user_facing: true
landing: auto_land
watch: 2h
The browser console. A fix carries the console tests and, for a visible change, a story or loop:e2e proof.
Never show fictional data outside ?demo, and never say something was watched, checked or passed when it was not.

## area: cli
paths: apps/cli/**
risk: medium
user_facing: true
landing: auto_land
watch: 2h
The ephyra command. It talks to the server over HTTP only and never prints a credential.

## area: server
paths: apps/server/**
risk: high
user_facing: true
landing: pull_request
The server, its workflows and its stores. Agents may research, reproduce, patch and prove here.
A named human approves C. Side effects keep their operation keys; an ambiguous write is reconciled, not retried.

## area: packages
paths: packages/**
risk: high
user_facing: false
landing: pull_request
Shared packages. They depend on core only and never on each other; test/boundaries.test.ts enforces it.

## area: design
paths: design/**
risk: medium
user_facing: false
landing: pull_request
Decision records. A change to a decision is proposed for a human to read, never landed by itself.

## area: self-control
paths: autonomy.md, thresholds.yaml, intents/**, ephyra/**, .ephyra/**, AGENTS.md, package.json, test/**, .railway/**, infra/**, packages/core/**, packages/policy/**, apps/server/src/config.ts, apps/server/src/compose.ts, apps/server/src/application.ts, apps/server/src/docs.ts, apps/server/src/drafts.ts, apps/server/src/policy-activation.ts, apps/server/src/self-telemetry.ts, apps/server/src/auth/**, apps/server/src/http/auth.ts, apps/server/src/wiring/landing.ts, apps/server/src/wiring/checkpoints.ts, apps/server/src/wiring/verification.ts, apps/server/src/wiring/budget.ts, apps/server/src/wiring/probes.ts, apps/server/src/setup/accounts.ts, apps/server/src/setup/account-store.ts, apps/server/src/setup/automation.ts, apps/server/src/setup/hosting.ts, apps/server/src/setup/network.ts, apps/server/src/setup/personal-landing.ts, apps/server/src/setup/provisioning.ts, apps/server/src/setup/repository.ts, apps/server/src/setup/forge-repository.ts, apps/server/src/setup/telemetry.ts
risk: critical
user_facing: false
checkpoints: A=blocking B=blocking C=blocking
landing: trail_ref
The rules the loop runs under: policy, thresholds, probes, proof, landing, budgets, sign-in, deployment and
the contracts every package shares. The loop cannot expand its own authority, budget or verification rules.
A patch here is a proposal for a named human to read in full. It never lands or applies by itself.
