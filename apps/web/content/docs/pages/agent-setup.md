---
title: Set up with an agent
summary: Hand the setup, or any page of these docs, to your coding agent. It asks for scoped access and you approve it.
---

You already work with a coding agent, and reading a setup guide to it line by line is a poor use of both of you. Ephyra publishes its documentation and its access instructions in a form an agent can read directly, and gives the agent a narrow credential of its own instead of yours.

## The one-line version

Paste this into your agent, in the repository you want to connect:

```prompt
Read {{docs}}/agent.md and help me set up Ephyra for this repository. Tell me what you find before you change anything, and ask me for whatever only I can decide.
```

`agent.md` is a brief written for agents: what Ephyra is, the rules that keep its evidence honest, the setup sequence, and a map of every page here as Markdown.

## Three ways to hand something over

| You want | Do this |
|---|---|
| The agent to read **one page** | Press **Copy page for an agent** at the top of that page, or give it the page's address with `.md` on the end, for example `{{docs}}/policy.md`. |
| The agent to know **your actual situation** | Run `ephyra handoff` in your repository. It prints a brief containing your server, the repository's remote and branch, what `ephyra doctor` found, and the links. Add `--copy` to put it on the clipboard. It contains no token. |
| The agent to have **everything** | Point it at `{{docs}}/llms-full.txt`, which is every page in reading order, or `{{docs}}/llms.txt` for the index. |

**Ask Claude** and **Ask ChatGPT** at the top of each page open a chat with that page's prompt already written.

## How the agent gets access

The agent follows [`auth.md`]({{auth}}), which your Ephyra server publishes. If you self-host, use your own server's `/auth.md`; it is the authority for that deployment.

<!-- steps -->
1. **Tell the agent who and what.** Give it your Not Organic DID, the HTTPS Git URL and the branch. Keep repository credentials in Ephyra's settings or your credential store, not in the chat.
2. **Review the claim.** The agent gives you an approval link and a six-digit code. Sign in with the account you intend, read the repository and the scopes it is asking for, then enter the code.
3. **Let it establish context.** With its own credential the agent can read the recorded setup, submit findings attributed to it, and start a supervised setup within grants you already have. Each claim permits one setup run.

Approval can connect the proposed repository when you have none saved. It cannot replace a repository you already connected.

### What the agent cannot do

Its scopes do not include checkpoint decisions, provider settings, spending grants, landing, or sending arbitrary messages. A private repository still needs a connection you configure. Changing the connected repository or workspace invalidates the old access.

See and revoke what you have approved at [agent access]({{site}}/agent/access), or with `ephyra agents` and `ephyra agents revoke <id>`.

> [!NOTE]
> This is a DID-bound profile inspired by [WorkOS `auth.md`](https://github.com/workos/auth.md): anonymous registration, then a claim bound to your Not Organic DID. There are no capabilities before the claim. Email-based `service_auth` and external provider ID-JAG identity assertions are unsupported. Follow the metadata and instructions your server publishes.

## What the agent establishes

Bootstrap inspects bounded parts of the pinned commit: documentation, manifests, CI, telemetry and deployment configuration. It records each source's path and digest, proposes context for you to confirm, and assesses six kinds of coverage: repository, checks, telemetry, deployment, knowledge and contact.

Each is reported as **observed**, **configured**, **missing** or **unknown**. [The quickstart](./quickstart#4-read-what-setup-found) explains the difference.

Three limits are worth knowing before you read its report:

- A saved telemetry connection does not prove ingestion.
- A queried window with no exceptions does not prove every user journey is instrumented.
- Repository text, agent findings and your answers are context. They cannot grant permissions or become passing proof.

## Questions before the first incident

Open your [inbox]({{app}}#/inbox) for setup requests before an incident exists. Ephyra asks about expected behavior and missing connections, keeps your answers attributed to you, and reassesses when settings change and on a schedule. Those reassessments do not allocate a new sandbox or call a paid model. A configuration request resolves when the capability or observation it was about is established.

If you explicitly enable an authenticated People bridge, Ephyra can also send one bundled notice to your configured owner contact. Unchanged requests do not repeat it. A bridge acknowledgement records that the transport accepted the message, not that a person read it.

## For the agent: the bootstrap API

Use the control-plane origin from `/auth.md`, an agent bearer credential, and a stable `Idempotency-Key` on every write. Reports must name the exact setup ID and repository head the server returned.

| Endpoint | Purpose |
|---|---|
| `GET /v1/agent/setup` | Read the recorded setup, coverage and open owner requests. |
| `POST /v1/agent/setup` | Start supervised setup under existing workspace grants. |
| `POST /v1/agent/bootstrap/report` | Submit bounded, attributed findings and proposed user journeys. |
| `POST /v1/agent/bootstrap/reassess` | Refresh coverage without repeating provisioning. |

Keep ceremony tokens in memory and access credentials in a credential store. Never put them in repository files, journals, model prompts or chat messages. Poll at the advertised interval, stop on an invalid grant, and obtain a new owner claim when needed.

## Next

- [What the owner does in the app](./quickstart)
- [The CLI the agent can use to read state](./cli)
- [The rules the agent is held to](./trust)
