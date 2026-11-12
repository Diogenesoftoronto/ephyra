---
title: Self-hosting
summary: Run Ephyra on your own machine in two commands, then add what makes it durable, signed-in and able to do real work.
---

You might self-host because your repository is not reachable from the internet, because you want the data on your own hardware, or because you want to read the code that touches your code. Ephyra is one server process plus Git. This page takes it from "runs on my laptop" to "runs for my team" in stages, and each stage is useful by itself.

## Stage 1: run it locally

You need [Bun](https://bun.sh) 1.4 and Git, and a checkout of the Ephyra source.

```sh
bun install
bun run build:console
bun run dev:server
```

The server listens on `http://localhost:3000`, with the console at `/app/`. `dev:server` creates a random API token on first run, keeps it in `.ephyra-local/dev-api-token` (readable by you alone), and stores data in `.ephyra-local/`.

Check it from another terminal:

```sh
curl http://localhost:3000/healthz

export EPHYRA_URL=http://localhost:3000
export EPHYRA_API_TOKEN="$(cat .ephyra-local/dev-api-token)"
export EPHYRA_PRINCIPAL=local-dev
bun apps/cli/src/main.ts doctor
```

> [!WARNING]
> This is **memory mode**. Without Convex, workflow and account state exist only while the process runs and are lost on restart. Quest journals in Git survive; the queue, inbox and ledger do not. Use it to look around, not to keep anything.

At this stage every signal goes to a person, no agent runs, and nothing is landed. That is what the defaults are for.

## Stage 2: keep state

Durable state lives in [Convex](https://convex.dev): signals, quests, events, the inbox, jobs, the operation ledger and a hash-chained audit log.

<!-- steps -->
1. **Deploy the functions** in `apps/server/convex` to a Convex project of your own.
2. **Set one shared secret** as `EPHYRA_CONVEX_SECRET`, on the Convex deployment and on the server. Every Convex function requires it.
3. **Point the server at it** with `CONVEX_URL`.
4. **Persist `EPHYRA_DATA_DIR`** (default `/data`). It holds Git journals, repository mirrors and local operation records. On a container platform this is a volume.

`ephyra status` then reports the mode as `convex` instead of `memory`.

## Stage 3: let people sign in

Until sign-in is configured, the service token is the only credential and whoever holds it can do anything. Sign-in changes that: decisions then require a signed-in person on the approver list, and the token can only read.

| Setting | Purpose |
|---|---|
| `EPHYRA_PUBLIC_ORIGIN` | The server's public address, as a bare origin: `https://ephyra.example.com`. |
| `EPHYRA_SESSION_KEY` | 32 random bytes, base64 or base64url. Encrypts sessions. |
| `EPHYRA_APPROVER_DIDS` | Comma-separated Not Organic DIDs allowed to approve. |

Generate the key for your installation and keep it out of Git:

```sh
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))'
```

The origin must also be registered with Not Organic as a client for sign-in to complete.

## Stage 4: point it at a repository and let it work

For a single-repository deployment:

| Setting | Purpose |
|---|---|
| `EPHYRA_REPO_URL` | The repository this server drives. Without it, signals are stored but not triaged. |
| `EPHYRA_BASE_REF` | The branch repairs build on. Default `refs/heads/main`. |
| `EPHYRA_AUTONOMY_FILE`, `EPHYRA_THRESHOLDS_FILE` | Your policy. Shadow-mode templates are used otherwise. |
| `EPHYRA_DECIDE` | The triage model. `none` (default) sends every signal to a person. |
| `EPHYRA_AGENT` | The coding agent: `none` (default), `claude-code`, `codex` or `amp`. Its CLI must be installed in the runner image. |

Turn these on one at a time, in shadow mode first. [Configuration](./configuration) lists every setting.

Multi-user hosted accounts, where each person connects their own repository, additionally need explicit runner and account grants (`EPHYRA_HOSTED_RUNNER`, `EPHYRA_HOSTED_ACCOUNTS`).

## A container

`infra/docker/Dockerfile.server` builds the server and console into one image, listening on port 3000 with a health check at `/healthz`. Mount a volume at `/data` and supply the settings above as environment variables. `infra/docker/Dockerfile.web` builds this public site, which is optional.

## What needs integration work

Be clear about these before you plan around them:

- **The local runner is not a sandbox.** It runs commands as a normal process for repositories you trust. It does not restrict network or resources.
- **Native Radicle and Tangled proposals** need host integration. Plain Git over HTTPS is the path that works end to end.
- **Remote Amp identity verification and respondent dispatch** need host integration.
- **Live providers are unverified by the test suite.** Tests run against recorded fixtures and fakes with no network. A passing suite does not show that a paid provider call or a production repair works in your environment.

## Updating

Pull, `bun install`, rebuild the console, deploy any changed Convex functions, restart. On start a worker takes the workspace lease, repairs its projections from the Git journals, and delivers only effects that were never started. Anything that was mid-flight with an unknown outcome waits for you: `ephyra ops`.

## Next

- [Every setting](./configuration)
- [How the pieces fit](./architecture)
- [What to check when it will not start](./troubleshooting#the-server-will-not-start)
