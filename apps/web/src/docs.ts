/** Public product documentation, grounded in the executable rather than the original platform proposal. */
export type DocsSection = { id: string; group: string; title: string; summary: string; body: string };
export const DOCS_UPDATED = "2026-11-08";
export const DOCS_DESCRIPTION = "Set up Ephyra with an agent, establish repository coverage, and configure policy, proof, deployment watch and self-hosting.";
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));

function code(label: string, language: string, source: string): string {
  return `<div class="docs-code"><div class="docs-code-bar"><span>${escape(label)}</span>`
    + `<button type="button" class="docs-copy" hidden aria-label="Copy ${escape(label)}">Copy</button></div>`
    + `<pre tabindex="0" aria-label="${escape(label)}"><code data-language="${escape(language)}">${escape(source)}</code></pre></div>`;
}

function table(caption: string, headings: string[], rows: string[][]): string {
  return `<div class="docs-table" tabindex="0" role="region" aria-label="${escape(caption)}"><table><caption>${escape(caption)}</caption>`
    + `<thead><tr>${headings.map(heading => `<th scope="col">${escape(heading)}</th>`).join("")}</tr></thead>`
    + `<tbody>${rows.map(row => `<tr>${row.map((cell, index) => index === 0
      ? `<th scope="row">${escape(cell)}</th>` : `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    id: "getting-started", group: "Start here", title: "Getting started",
    summary: "Connect your first repository and understand what setup prepares.",
    body: `<p>Ephyra turns production signals into <strong>trails</strong>: recorded work that moves from evidence to a failing reproduction, a
patch, proof, landing and watch. A trail keeps its history in Git.</p>
<ol class="docs-steps">
<li><strong>Open the application.</strong> <a href="/app/">Sign in with Not Organic</a> to create your personal workspace.</li>
<li><strong>Connect a repository.</strong> Use an HTTPS Git URL and, for a private repository, a scoped credential. Setup discovers the default branch.</li>
<li><strong>Choose how to review.</strong> Autonomous is the default setup mode. Choose Supervised if you want blocking checkpoints during the repair loop.</li>
<li><strong>Follow setup.</strong> Ephyra inspects the pinned commit, prepares configuration, discovers checks and records execution readiness.
Read any blockers before expecting the loop to run.</li>
</ol>
<div class="docs-note"><strong>A connection is the first step.</strong><p>A runnable workspace also needs model access, an isolated runner,
verified checks, applicable proof sources, and landing and watch integrations. Setup identifies what is missing.</p></div>
<p>Existing policy is retained. Prepared files include <code>autonomy.md</code>, <code>thresholds.yaml</code>,
<code>intents/application.md</code> and verification, evidence and recovery configuration. Generated prose and discovered commands still need
actual verification.</p>
<p class="docs-next"><a href="#connections">Configure workspace connections <span aria-hidden="true">→</span></a></p>`,
  },
  {
    id: "agent-setup", group: "Start here", title: "Set up with an agent",
    summary: "Give an agent scoped setup access and establish useful observation before the first incident.",
    body: `<p>Give your coding agent <a href="/auth.md">Ephyra's <code>auth.md</code> instructions</a>. They describe registration,
owner approval, credential renewal and the bootstrap API on the connected control plane. Use your own server's <code>/auth.md</code> when
self-hosting.</p>
${code("Ask your coding agent", "text", `Read https://ephyra.quest/auth.md and help me set up Ephyra for this repository.
Inspect the pinned repository, identify its important user journeys, and establish what Ephyra can observe and verify.
Ask me for missing expected behavior or connections. Report only checks and observations that actually happened.`)}
<h3>Approve the exact repository and scopes</h3>
<ol class="docs-steps">
<li><strong>Identify the owner and repository.</strong> Give the agent your Not Organic DID, HTTPS Git URL and branch.
Keep repository credentials in Ephyra's settings or your credential store.</li>
<li><strong>Review the claim.</strong> The agent gives you an approval link and a six-digit code. Sign in with the intended Not Organic
account, inspect the repository and requested scopes, then enter the code.</li>
<li><strong>Let the agent establish context.</strong> Its separate credential can read setup, submit attributed findings and start supervised
setup within your existing grants. Each claim permits one setup run. Approval can connect the proposed repository when none is saved;
it cannot replace another connected repository.</li>
</ol>
<p>The agent's scopes do not permit human checkpoint decisions, provider settings, spending grants, landing or arbitrary external messages.
Private repository credentials still need an owner-configured connection. <a href="/agent/access">Review or revoke agent access</a> at any time.
Changing the connected repository or workspace invalidates the old access.</p>
<div class="docs-note"><strong>An explicit DID-bound profile.</strong><p>Inspired by <a href="https://github.com/workos/auth.md">WorkOS
<code>auth.md</code></a>, Ephyra supports anonymous registration followed by a claim bound to your Not Organic DID. It has no private pre-claim
capabilities. Email-based <code>service_auth</code> and external provider ID-JAG identity assertions are unsupported. Follow the metadata and
instructions published by your server.</p></div>
<h3>Establish eyes, ears and a way to ask</h3>
<p>Bootstrap inspects bounded documentation, manifests, CI, telemetry and deployment configuration at the pinned commit. It records source paths
and digests, proposes context to confirm, and assesses repository checks, telemetry, deployed revision, product context and contact coverage.</p>
${table("Observation coverage", ["Status", "Meaning"], [
  ["Observed", "The assessment records an actual observation for this part of the setup."],
  ["Configured", "A connection is present; the corresponding observation is still missing."],
  ["Missing", "A required connection or capability is absent."],
  ["Unknown", "The available evidence cannot establish this coverage."],
])}
<p>Open your owner <a href="/app/#/inbox">Inbox</a> for setup requests before an incident exists. Ephyra asks about expected behavior and missing
connections, retains attributed answers, and reassesses when settings change and on scheduled checks. Those reassessments do not allocate a new
sandbox or call a paid model. Configuration requests resolve when their corresponding capability or observation is established.</p>
<p>If you explicitly enable an authenticated People bridge, Ephyra can also send a bundled notice to your configured owner contact.
Unchanged requests do not repeat the notice. A bridge acknowledgement records transport acceptance, not proof that a person read it.</p>
<p>A saved telemetry connection does not prove ingestion. A queried window with no exceptions does not prove that every user journey is
instrumented. Repository text, agent findings and owner answers are context; they cannot grant permissions or become passing proof.</p>
<details><summary>Agent bootstrap API</summary>
<p>Use the control-plane origin from <code>/auth.md</code>, an agent bearer credential and a stable <code>Idempotency-Key</code> for writes.
Reports must name the exact setup ID and repository head returned by the server.</p>
${table("Scoped agent setup endpoints", ["Endpoint", "Purpose"], [
  ["GET /v1/agent/setup", "Read the recorded setup, coverage and open owner requests."],
  ["POST /v1/agent/setup", "Start supervised setup under existing workspace grants."],
  ["POST /v1/agent/bootstrap/report", "Submit bounded, attributed findings and proposed user journeys."],
  ["POST /v1/agent/bootstrap/reassess", "Refresh coverage without repeating provisioning."],
])}
<p>Keep ceremony tokens in memory and access credentials in a credential store. Never put them in repository files, journals, model prompts or
chat messages. Poll at the advertised interval, stop on an invalid grant, and obtain a new owner claim when needed.</p></details>`,
  },
  {
    id: "trails", group: "Start here", title: "How a trail moves",
    summary: "Follow the evidence, checkpoints and outcomes of a repair.",
    body: `<ol class="docs-loop" aria-label="The repair lifecycle">
<li><strong>Signal</strong><span>A reported problem</span></li><li><strong>Evidence</strong><span>Observed context</span></li>
<li><strong>Repro</strong><span>A failing check</span></li><li><strong>Patch</strong><span>A candidate fix</span></li>
<li><strong>Proof</strong><span>Required checks</span></li><li><strong>Landing</strong><span>An authorized write</span></li>
<li><strong>Watch</strong><span>Deployment coverage</span></li><li><strong>Closed</strong><span>A recorded outcome</span></li></ol>
<p>Triage decides whether a signal should become new work, join an existing trail or reach a person. Research records a hypothesis. Reproduction
establishes the failure before a plan becomes a patch.</p>
${table("The three review checkpoints", ["Checkpoint", "What is reviewed"], [
  ["A · Hypothesis", "The proposed cause and its supporting evidence."],
  ["B · Plan", "The reproduced failure and the intended repair."],
  ["C · Patch", "The exact revision, diff and proof bundle."],
])}
<p>Approvals bind to the revision, head and proof that were reviewed. High and critical changes require a named human at C. Critical changes
require manual landing.</p>
<p>The console shows a trail's evidence, activity, files and runs. A parked trail carries a reason; an unavailable integration cannot create a
passing result. Closed repairs can contribute their observed reproduction as a regression probe.</p>`,
  },
  {
    id: "connections", group: "Start here", title: "Workspace connections",
    summary: "Give the workspace the repository, models and evidence it can use.",
    body: `<h3>Repository</h3><p>The hosted HTTPS path supports GitHub, GitLab, Forgejo and other public HTTPS smart Git endpoints. Use a scoped
token where the repository needs authentication. SSH URLs, localhost and private-network endpoints are not supported by hosted account setup.</p>
<p>Changing the repository or branch selects a separate workspace, preserving earlier work. Recheck project-specific telemetry and knowledge
selections after switching.</p>
<h3>Models and execution</h3><p>Choose hosted Not Organic models or supported OpenAI, Anthropic or compatible model access. Saving a key checks
model discovery; it does not run a generation. The host must grant an isolated runner before an account can execute repairs.</p>
<p>Personal autonomous repairs require reported costs. A valid BYOK key alone does not establish cost reporting: an unknown-cost result blocks
continuation. See <a href="#budgets">budgets and usage</a>.</p>
<h3>Telemetry and knowledge</h3><p>Connect a scoped PostHog project for supported exception ingestion and landing-watch coverage. Provide a
deployment receipt URL to attribute the landed commit to production.</p>
<p>Optional Not Organic knowledge connections let you select readable resources and eligible read-only search tools. The account must grant the
exact source and tool. Those selections are checked again when evidence is used.</p>
<div class="docs-note"><strong>Keep credentials in connections.</strong><p>Repository tokens and model keys stay on the control plane. Put
observations in evidence and grant authority through account settings and policy.</p></div>`,
  },
  {
    id: "policy", group: "Control the loop", title: "Policy and checkpoints",
    summary: "Set authority by area and understand draft, published and active policy.",
    body: `<p>Autonomy policy describes areas of the repository, their paths and risk, checkpoint behavior, allowed landing modes and watch
windows. Start with a narrow area whose checks you understand.</p>
${code("A supervised, low-risk area", "text", `# Autonomy policy

## defaults
mode: shadow
checkpoints: A=blocking B=blocking C=blocking
landing: trail_ref
watch: 2h

## area: documentation
paths: docs/**
risk: low
user_facing: false
Keep documentation accurate without changing application behavior.`)}
<p>This example keeps checkpoints blocking and permits a trail ref. Risk must reflect the real blast radius; lowering a label cannot replace required proof.</p>
<h3>Draft → published → active</h3><p>Workspace editing saves a draft. Publishing writes a policy Git ref. To put it into effect, an approver
explicitly activates the reviewed publication, checking its commit, content digest and previous active version.</p>
<p>Activation reloads Ephyra's policy. It does not deploy application code. Changed policy invalidates affected unfinished work and stale
approval. Already-authorized landing and watch retain their recorded authority.</p>
<p>When a save or activation has an uncertain outcome, refresh its recorded status before repeating it. An operation key identifies the original action.</p>`,
  },
  {
    id: "proof", group: "Control the loop", title: "Proof requirements",
    summary: "Know which observations must exist before a repair can land.",
    body: `<p>Every repair needs a reproduction that fails before the patch and passes after it, test results, and the scope of its diff. Further
requirements depend on risk and whether the change affects a user or interface.</p>
${table("Evidence added by scope and risk", ["Scope", "Additional requirements"], [
  ["Any UI change", "Story rendering and interaction results."],
  ["Medium, high or critical", "Executed regression and intent probes, plus bug review."],
  ["Non-low UI", "Visual differences and named approval of changed visuals."],
  ["Non-low user-facing", "A synthetic persona study."],
  ["High or critical", "Traffic replay and named-human checkpoint C approval."],
  ["High/critical UI", "A recording or terminal recording."],
  ["High/critical user-facing", "A completed real-respondent study."],
  ["Critical", "Manual landing; automatic and live landing are forbidden."],
])}
<h3>Configure a trusted verification harness</h3><p>Accepted-base <code>.ephyra/proof.json</code> selects UI and replay reporters. Declare the
complete harness and dependency closure in <code>protectedPaths</code>. Candidate modifications to that closure invalidate the verifier.</p>
${code("A repository reporter", "json", JSON.stringify({ schema: 1, commands: [{ id: "stories", command: ["bun", "run", "proof:stories"],
  protectedPaths: ["package.json", "bun.lock", "proof/**"], kinds: ["story_render", "story_interaction"] }] }, null, 2))}
<p>The reporter must implement Ephyra's exact-bound JSON report contract and return actual executed observations. Merely adding this
configuration does not produce evidence. Repository reporters cannot supply persona or human-study provenance.</p>
<details class="docs-contract"><summary>Reporter response contract</summary><p>The command writes JSON to stdout and exits successfully only
after its checks complete. Read the binding from <code>EPHYRA_PROOF_TRAIL</code>, <code>EPHYRA_PROOF_REV</code>, <code>EPHYRA_PROOF_BASE</code>
and <code>EPHYRA_PROOF_HEAD</code>. Revision is a number.</p>
${code("Reporter response shape; illustrative values", "json", JSON.stringify({ schema: 1, trailId: "EXACT_TRAIL_UUID", rev: 1,
  base: "EXACT_BASE_COMMIT", head: "EXACT_HEAD_COMMIT", items: [
    { kind: "story_render", surface: "web", stories: ["ACTUAL_STORY_ID"], failed: [], uncovered: [] },
    { kind: "story_interaction", surface: "web", stories: ["ACTUAL_STORY_ID"], failed: [], log: "ACTUAL_EXECUTION_LOG" }] }, null, 2))}
<p>This illustrates the schema, not a passing run. Populate story IDs, failures, coverage and logs from the reporter's actual observations. Emit
only the evidence kinds granted to that command.</p></details>
<p>Script intent probes are supported. Other designed HTTP, trace and agent probe kinds need execution adapters. Missing probes, absent studies
and unavailable checks remain explicit blockers.</p>`,
  },
  {
    id: "study-evidence", group: "Control the loop", title: "Study evidence",
    summary: "Import actual study results through an operator grant or a signed provider.",
    body: `<p>Synthetic personas and real respondents are different proof items. A persona study stays synthetic and cannot satisfy a requirement
for human evidence.</p>
${table("Two receipt transports", ["Option", "How evidence arrives"], [
  ["Operator directory", "An operator verifies a completed export and places its receipt in the protected receipt directory."],
  ["Signed provider callback", "A granted provider submits an Ed25519-signed receipt to POST /callbacks/proof."],
])}
<p>Both options require operator-owned absolute paths in <code>EPHYRA_PROOF_RECEIPTS_DIR</code> and <code>EPHYRA_PROOF_TRUST_FILE</code>. Grants
name the exact source, workspace and permitted evidence kinds. Account settings and repository code cannot create those grants.</p>
${code("A signed-source trust grant", "json", JSON.stringify({ schema: 1, grants: [{ sourceId: "study-service", workspaces: ["YOUR_WORKSPACE_ID"],
  kinds: ["persona_study", "voxq_study", "visual_approval"], transport: "signed", publicKey: "ED25519_SPKI_PEM_PUBLIC_KEY" }] }, null, 2))}
<p>For directory import, select <code>transport: "directory"</code> and omit <code>publicKey</code>. Unsigned directory receipts cannot be
submitted over HTTP.</p>
<p>Each completed receipt binds the trail, revision, base, head, provider operation and expiry. Conflicting, expired or unauthorized receipts are
rejected. These transports import completed evidence; automatic respondent dispatch additionally needs a host provider integration, a named spend
approval and remaining budget.</p>
<details class="docs-contract"><summary>Receipt envelope and signing contract</summary>
${code("Study receipt shape; replace all illustrative values", "json", JSON.stringify({ receipt: {
  schema: 1, sourceId: "study-service", workspaceId: "YOUR_WORKSPACE_ID",
  trailId: "EXACT_TRAIL_UUID", rev: 1, base: "EXACT_BASE_COMMIT", head: "EXACT_HEAD_COMMIT", operationKey: "ACTUAL_PROVIDER_OPERATION",
  observedAt: "ISO_OBSERVATION_TIME", expiresAt: "ISO_EXPIRY_TIME", items: [{ kind: "persona_study", synthetic: true,
    study: "ACTUAL_STUDY_ID", runId: "ACTUAL_PROVIDER_RUN_ID", report: "ACTUAL_COMPLETED_REPORT" }] }, signature: "BASE64URL_ED25519_SIGNATURE" }, null, 2))}
<p>Sign the UTF-8 bytes of <code>canonicalJson(receipt)</code>, exported by <code>@ephyra/core</code>, with the provider's Ed25519 private key.
Encode the signature as unpadded base64url. Keep the private key at the provider; the server grant holds its public key.</p>
<p>For directory import, omit <code>signature</code>. In a source checkout, use <code>proofReceiptPath(directory, receipt)</code> from
<code>@ephyra/server</code> to determine the file path. A receipt remains immutable for that source, operation and exact
revision.</p></details>`,
  },
  {
    id: "landing-watch", group: "Control the loop", title: "Landing and watch",
    summary: "Attribute the remote write to an actual deployment and observe the outcome.",
    body: `<p>The stock personal HTTPS workflow writes the exact reviewed commit through the current account's repository authority, using
conditional remote-ref updates. Landing requires a deployment observer and telemetry coverage.</p>
<h3>Publish a deployment receipt</h3><p>Configure a public HTTPS endpoint that returns the actual deployed revision. It receives no account
credentials. The repository, branch and full SHA must match the saved connection and expected landed commit.</p>
${code("Deployment receipt response", "json", JSON.stringify({ schema: 1, repository: "https://git.example.org/team/application.git", branch: "main",
  commit: "FULL_SHA1_OR_SHA256_COMMIT", deployedAt: "2026-11-08T12:00:00.000Z" }, null, 2))}
<p>Replace the commit and timestamp with values from the deployment that actually happened. Use a URL without embedded credentials, query
parameters or a fragment.</p>
<h3>Observe the complete window</h3><p>Watch needs the deployed commit, applicable probes and complete attributed telemetry. PostHog computation
must cover the requested history and the required watch end. Retrieving an old cached result does not make its observations new.</p>
<p>A missing deployment, stale computation, truncated history or unavailable probe cannot establish a clean close. Regression and rollback
actions retain their own operation receipts; uncertain remote outcomes require reconciliation.</p>
<p>Native Radicle and Tangled proposal writes are host integrations. Closing a proposal is distinct from reverting deployed code, so canonical
landing and rollback need an explicit strategy.</p>`,
  },
  {
    id: "budgets", group: "Operate", title: "Budgets and usage",
    summary: "Bound cumulative work and keep unknown costs visible.",
    body: `<p>Each trail accumulates reported tokens, metered inference spend and executed wall time. Retrying or restarting does not reset those
counters. Waiting at a checkpoint does not consume execution time.</p>
${table("Deployment budget defaults", ["Setting", "Default"], [
  ["EPHYRA_TRAIL_TOKENS", "2,000,000 reported tokens"],
  ["EPHYRA_TRAIL_WALLCLOCK_S", "14,400 execution seconds"],
  ["EPHYRA_TRAIL_SPEND_MICROUSD", "0; no metered inference allowance"],
  ["EPHYRA_REQUIRE_KNOWN_COST", "false for deployment workspaces; always true for personal workspaces"],
])}
<p>The operator must choose a metered allowance explicitly. Personal workspaces stop when a required cost is unknown. Some BYOK providers do not
return a reconciled cost, even when the request succeeds.</p>
<p>Sandbox resource grants are separate from inference budgets. A model allowance does not cap cloud VM billing. CLI providers cannot enforce
limits their interfaces do not expose; reported usage is recorded after execution.</p>
<h3>Stopping and recovery</h3><p>Killing a trail aborts active work and attempts to destroy its runner handles. Stop receipts distinguish
confirmed destruction, pending allocation and uncertain cleanup. One fenced worker owns a durable workspace; stale work cannot adopt a new
owner's authority.</p>
<p>Pending or ambiguous external operations require reconciliation. Recovery restores recorded work without blindly repeating a provider call or
remote write.</p>`,
  },
  {
    id: "self-hosting", group: "Operate", title: "Self-hosting",
    summary: "Boot a local development API, then add durable state and account authority.",
    body: `<h3>Local development</h3><p>From an Ephyra source checkout, install Bun 1.4 and Git. Build the console and generate a random service token:</p>
${code("Start the development server", "sh", `bun install
bun run --filter @ephyra/console build

export EPHYRA_API_TOKEN="$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')"
EPHYRA_DATA_DIR="$PWD/.ephyra-local" bun run --filter @ephyra/server start`)}
<p>In another shell with the token available, check health and authenticated API access:</p>
${code("Check the local API", "sh", `curl http://localhost:3000/healthz\n\ncurl \\\n  -H "Authorization: Bearer $EPHYRA_API_TOKEN" \\\n  -H "X-Ephyra-Principal: local-dev" \\\n  http://localhost:3000/v1/trails`)}
<div class="docs-note"><strong>This is memory mode.</strong><p>Without Convex configuration, workflow and account state are development-only and
are lost on restart. This command does not configure a personal account repair workflow.</p></div>
<h3>Durable hosting</h3><p>Deploy <code>apps/server/convex</code> to your own Convex project. Set the same <code>EPHYRA_CONVEX_SECRET</code>
there and on the server, then configure that deployment's <code>CONVEX_URL</code>. Persist <code>EPHYRA_DATA_DIR</code> for Git journals,
repository mirrors and local operation records.</p>
<p>Browser sign-in needs <code>EPHYRA_PUBLIC_ORIGIN</code>, <code>EPHYRA_SESSION_KEY</code> (32 random bytes encoded as base64 or base64url), and
approver configuration. Generate credentials for your installation and keep them outside Git.</p>
<p>Hosted account execution also needs explicit runner and account grants. Self-hosted CLI agents require their CLI in the runner image. Native
forge transports and remote Amp identity verification require host integration.</p>`,
  },
  {
    id: "reference", group: "Operate", title: "API and availability",
    summary: "Find the public API entry points and current integration boundaries.",
    body: `<p>The control-plane API is served by your Ephyra server, separately from this documentation site. Service-token requests use
<code>Authorization: Bearer …</code> and <code>X-Ephyra-Principal</code>. Personal account routes require an authenticated human session.</p>
${table("Useful API routes", ["Route", "Purpose"], [
  ["GET /healthz", "Store health and the exported release revision."],
  ["GET /v1/me", "Authenticated identity and decision permissions."],
  ["GET /v1/trails · GET /v1/inbox", "Recorded trail state and review requests."],
  ["GET /v1/runs · GET /v1/usage", "Agent activity and recorded usage."],
  ["GET /v1/policy/active", "The active policy receipt, or null."],
  ["GET /v1/ops", "Worker ownership, dead jobs and reconciliation state."],
])}
<p>Some mutating endpoints require operation keys. Account writes also require current account, workspace and version bindings. Check the
recorded outcome before repeating an uncertain action. The service token cannot approve a personal human checkpoint when sign-in is required.</p>
<h3>What needs configuration</h3><p>Supported paths include account-scoped HTTPS repositories, selected model access, recorded setup, script
probes, trusted proof receipts, conditional Git landing, and attributed PostHog watch. Each path still needs its declared capabilities and
permissions.</p>
<p>Native proposal transports, remote Amp reports and respondent dispatch need host integrations. Other designed intent probe types and proposed
hunting workflows are not advertised as configured capabilities. A healthy server or passing local test does not establish a paid provider run or
a production repair.</p>
<p class="docs-next"><a href="/app/">Open your workspace <span aria-hidden="true">↗</span></a><a href="/security">Read the security policy</a></p>`,
  },
];

/** Text export keeps code readable and never includes the interactive page shell. */
export function docsPlainText(): string {
  const plain = (html: string) => html.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, "")
    .replace(/<\/(?:p|h3|li|tr|pre|div|ol|table|caption|summary)>/g, "\n\n").replace(/<\/(?:td|th)>/g, "\t")
    .replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return `# Ephyra documentation\n\nPre-alpha · Updated ${DOCS_UPDATED}\n\n${DOCS_DESCRIPTION}\n\n`
    + DOCS_SECTIONS.map(section => `## ${section.title}\n\n${section.summary}\n\n${plain(section.body)}`).join("\n\n") + "\n";
}

export function docsBody(): string {
  const groups = [...new Set(DOCS_SECTIONS.map(section => section.group))];
  const nav = groups.map(group => `<div class="docs-nav-group"><p>${escape(group)}</p><ul>`
    + DOCS_SECTIONS.filter(section => section.group === group).map(section => `<li>`
      + `<a href="#${section.id}" data-doc-link="${section.id}">${escape(section.title)}</a></li>`).join("")
    + `</ul></div>`).join("");
  const sections = DOCS_SECTIONS.map(section => `<section class="docs-section" data-doc-id="${section.id}" data-doc-summary="${escape(section.summary)}">`
    + `<h2 id="${section.id}" tabindex="-1"><a href="#${section.id}" aria-label="${escape(section.title)}, link to section">${escape(section.title)}</a></h2>`
    + `<p class="docs-summary">${escape(section.summary)}</p>${section.body}</section>`).join("");
  return `<div class="docs-guide"><a class="docs-skip" href="#getting-started">Skip to the guide</a>
<div class="docs-intro"><div><p class="docs-label">Documentation <span>Pre-alpha</span></p><h1>Make the loop your own.</h1>
<p class="docs-lede">Connect your repository. Set the boundaries. Follow every repair from signal to proof.</p></div>
<div class="docs-tools"><button type="button" id="docs-theme" hidden>Theme: system</button><a href="/docs.txt">Read as text <span
aria-hidden="true">↗</span></a></div></div>
<div class="docs-layout"><aside class="docs-sidebar" aria-label="Guide navigation">
<div class="docs-search" hidden><label for="docs-search">Search the guide</label><div class="docs-search-field"><input id="docs-search"
type="search" placeholder="Policy, proof, budgets…" autocomplete="off" spellcheck="false" aria-controls="docs-results"><kbd
aria-hidden="true">/</kbd></div>
<div id="docs-results" hidden><p id="docs-result-status" role="status" aria-live="polite"></p><ul></ul></div></div>
<details class="docs-menu" open><summary>In this guide <span aria-hidden="true">⌄</span></summary><nav aria-label="Documentation">${nav}</nav></details>
<p class="docs-updated">Updated <time datetime="${DOCS_UPDATED}">8 November 2026</time></p></aside>
<div class="docs-reading">${sections}<p class="docs-back-top"><a href="#top">Back to top ↑</a></p></div></div>
<span class="docs-sr-only" id="docs-announcement" role="status" aria-live="polite"></span></div>`;
}
