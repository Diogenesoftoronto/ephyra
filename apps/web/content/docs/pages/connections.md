---
title: Workspace connections
summary: What Ephyra needs access to, why it needs each thing, and how little you can give it.
---

Each connection answers a question the loop cannot answer by itself. If a quest is not starting, or stops early, the cause is usually one of these.

| Connection | The question it answers | Without it |
|---|---|---|
| **Repository** | What code, and where do repairs go? | Nothing runs. |
| **Models** | Who does the thinking? | Signals are stored; no agent works them. |
| **Runner** | Where does untrusted code execute? | No reproduction, patch or proof. |
| **Telemetry** | What is going wrong, and did the fix hold? | No signals arrive, and landings cannot be watched. |
| **Deployment receipt** | Is the landed commit actually in production? | The watch cannot start. |
| **Knowledge** | What else should research read? | Research uses the repository alone. |

All of them live in **Settings** in the console. `ephyra setup` and `ephyra doctor` report which are missing.

## Repository

The hosted HTTPS path supports GitHub, GitLab, Forgejo and other public HTTPS smart-Git endpoints. For a repository that needs authentication, use a token scoped to that one repository.

SSH URLs, `localhost` and private-network endpoints are not supported by hosted account setup. If your repository is only reachable inside your network, [self-host](./self-hosting).

> [!TIP]
> Give the token the narrowest scope your forge offers: one repository, contents read and write. Ephyra writes only quest refs and, where policy allows, the branch it lands on.

Changing the repository or branch selects a **separate workspace**. Your earlier work is preserved under the old one. After switching, recheck telemetry and knowledge selections, which are specific to a project.

## Models and execution

Choose hosted Not Organic models, or bring your own OpenAI, Anthropic or compatible access.

Saving a key checks that models can be listed. It does not run a generation, so a saved key is *configured*, not *observed*.

Two things catch people out:

- **A key is not a runner.** The host must grant an isolated runner before an account can execute repairs. Without one, agents have nowhere to work.
- **Personal autonomous repairs require reported costs.** A valid key of your own does not establish cost reporting. If a provider returns no cost, the result is recorded as unknown-cost and the quest stops there. See [Budgets](./budgets).

## Telemetry

Connect a scoped PostHog project. It serves two purposes: exceptions arrive as signals, and after a landing the same project supplies the observations for the watch.

Servers also accept OTLP/HTTP JSON logs and traces at `/otlp`. Protobuf is not accepted yet.

A saved telemetry connection does not prove ingestion, and a queried window with no exceptions does not prove that every user journey is instrumented.

## Deployment receipt

Ephyra needs to know that the commit it landed is the one your users are running. You provide a public HTTPS URL that returns the deployed revision. It receives no credentials from Ephyra. [Landing and watch](./landing-watch#publish-a-deployment-receipt) has the response format.

## Knowledge

Optional Not Organic knowledge connections let research read more than the repository: you select readable resources and eligible read-only search tools once, and research uses them automatically.

The account must grant the exact source and tool. Those selections are checked again each time evidence is used, so revoking access upstream takes effect immediately.

## People

You can name who should be asked when an investigation has a question, and optionally enable an authenticated bridge that sends a bundled notice to that contact. A bridge acknowledgement means the transport accepted the message. It is not proof that a person read it.

## Where credentials live

Repository tokens and model keys stay on the control plane. They are never written to journals, committed, logged, or sent to a model. Put observations in evidence, and grant authority through account settings and policy, not through text in the repository.

## Next

- [Decide what Ephyra may do](./policy)
- [What happens after a landing](./landing-watch)
