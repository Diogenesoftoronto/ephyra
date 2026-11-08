# Ephyra Amp reporting plugin

Copy `plugins/ephyra.ts` into the driven repository's `.amp/plugins/` and configure the public
`EPHYRA_AMP_REPORT_ORIGIN=https://your-ephyra-host` in the executor environment. The file is standalone;
it does not require Ephyra's workspace packages in the driven repository. Amp's installed
`amp plugins show-docs` API defines its lifecycle hooks and tools. Ephyra waits for plugin readiness.

The host must configure an `AmpReportInbox` with a cryptographic identity verifier and current
workspace/trail authorization. The verifier checks the issuer, signature, audience, expiry and exact
authenticated thread ID. No issuer, JWKS URL or undocumented Amp identity claim is assumed. The route
is `POST /amp/reports/:nonce`; its nonce is public task metadata, not authorization.

Orb identity defaults to `amp orb id-token --audience <origin>`. A self-hosted runner can use an
operator-provided short-lived workload identity command through `EPHYRA_AMP_REPORT_IDENTITY_COMMAND`,
a JSON argv array with optional `{audience}` and `{threadId}` substitutions. This command is read
from the host environment, never from a task or model output. A custom plugin installer can instead
provide the `identity(audience, threadId)` callback. Tokens stay in plugin memory and HTTP headers.

`ephyra_report` accepts no artifact arguments. It reads the actual repro file, or packages the actual
patch commits in a bounded incremental Git bundle. The server rechecks the task and authenticated
thread; the receiving runner verifies the exact bundle ref, head, ancestry and trail trailers before
returning a successful patch step. Independent proof still runs afterward. Delivery uncertainty
blocks resending the report. `ephyra_commit` commits selected existing files with the trail trailer.

The plugin reports its actual tool decisions and conservatively blocks arbitrary shell commands and
protected file paths during Ephyra tasks. This gate is not an OS sandbox, network boundary or complete
filesystem policy. Use a host-enforced isolated service profile. Deleted-file commits and arbitrary
shell/test execution need a separate host-granted tool; they are not implicitly authorized by a prompt.

Offline tests exercise the standalone plugin, actual local Git bundles and repro bytes, fictitious
short-lived authentication, revocation, task substitution, immutable receipts and uncertain delivery.
No live Amp run, provider OIDC claim, remote executor, cloud charge or policy-enforcement attestation
has been verified. Without configured authenticated reporting, remote file-producing steps fail
before requesting another paid turn.
