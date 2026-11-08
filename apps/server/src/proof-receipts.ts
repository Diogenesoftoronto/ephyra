import { constants } from "node:fs";
import { mkdir, open, readdir, lstat, link, unlink } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { IsoTime, ProofItem, Sha, Unverified, canonicalJson, sha256Hex } from "@ephyra/core";
import type { ProofEvidenceContext } from "@ephyra/agent";
import type { BoundProofEvidence } from "./wiring/verification.ts";

const MAX_BYTES = 256_000;
const Kind = z.enum(["persona_study", "voxq_study", "visual_approval"]);
const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Grant = z.object({ sourceId: identifier, workspaces: z.array(identifier).min(1).max(1000),
  kinds: z.array(Kind).min(1).max(3), transport: z.enum(["directory", "signed"]),
  publicKey: z.string().min(1).max(5000).optional() }).strict();
export const ProofReceipt = z.object({ schema: z.literal(1), sourceId: identifier, workspaceId: identifier,
  trailId: z.string().uuid(), rev: z.number().int().positive(), base: Sha, head: Sha,
  operationKey: identifier, observedAt: IsoTime, expiresAt: IsoTime,
  items: z.array(ProofItem).min(1).max(30) }).strict();
export type ProofReceipt = z.infer<typeof ProofReceipt>;
export const ProofReceiptEnvelope = z.object({ receipt: ProofReceipt,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/).optional() }).strict();
export type ProofReceiptEnvelope = z.infer<typeof ProofReceiptEnvelope>;

const binding = (receipt: Pick<ProofReceipt, "workspaceId" | "trailId" | "rev" | "base" | "head">) => sha256Hex(canonicalJson({
  workspaceId: receipt.workspaceId, trailId: receipt.trailId, rev: receipt.rev, base: receipt.base, head: receipt.head,
}));
export function proofReceiptPath(directory: string, receipt: ProofReceipt): string {
  return join(directory, binding(receipt), `${sha256Hex(canonicalJson({ sourceId: receipt.sourceId, operationKey: receipt.operationKey }))}.json`);
}

async function boundedFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Unverified("bounded regular proof receipt file");
    const data = await file.readFile("utf8");
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Unverified("bounded proof receipt file");
    return data;
  } finally { await file.close(); }
}

async function directory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Unverified("proof receipt directory must not be a symlink");
}

/** Trust comes from an operator-owned grant file, never from a repository or a model-authored report. */
export class TrustedProofReceipts {
  constructor(private readonly options: { directory: string; trustFile: string; now?: () => Date }) {
    if (!isAbsolute(options.directory) || !isAbsolute(options.trustFile)) throw new Error("Proof receipt paths must be absolute");
  }

  private async grants() {
    const value = z.object({ schema: z.literal(1), grants: z.array(Grant).max(100) }).strict()
      .parse(JSON.parse(await boundedFile(this.options.trustFile)));
    if (new Set(value.grants.map(grant => grant.sourceId)).size !== value.grants.length)
      throw new Unverified("unique proof source identities");
    return value.grants;
  }

  async supports(workspace: string, kind: z.infer<typeof Kind>): Promise<boolean> {
    return (await this.grants()).some(grant => grant.workspaces.includes(workspace) && grant.kinds.includes(kind));
  }

  private async checked(raw: unknown, signedOnly = false): Promise<ProofReceiptEnvelope> {
    const value = ProofReceiptEnvelope.parse(raw);
    const receipt = value.receipt;
    const grant = (await this.grants()).find(candidate => candidate.sourceId === receipt.sourceId);
    if (!grant || !grant.workspaces.includes(receipt.workspaceId)
      || receipt.items.some(item => !grant.kinds.includes(item.kind as z.infer<typeof Kind>)))
      throw new Unverified("proof source workspace and evidence-kind grant");
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (Date.parse(receipt.observedAt) > now || Date.parse(receipt.expiresAt) <= now
      || Date.parse(receipt.expiresAt) <= Date.parse(receipt.observedAt)) throw new Unverified("proof receipt observation and expiry");
    for (const item of receipt.items) {
      if (item.kind === "persona_study" && (!item.study.trim() || !item.runId.trim() || !item.report.trim())
        || item.kind === "voxq_study" && (!item.study.trim() || !item.runId.trim() || !item.report.trim()
          || item.respondents <= 0 || item.spendMicrousd < 0)
        || item.kind === "visual_approval" && (!item.by.trim() || !item.approved.length || Date.parse(item.at) > now))
        throw new Unverified("completed external proof observation");
    }
    if (signedOnly && grant.transport !== "signed") throw new Unverified("signed proof source required");
    if (grant.transport === "signed") {
      if (!grant.publicKey || !value.signature) throw new Unverified("proof receipt signature required");
      const key = createPublicKey(grant.publicKey);
      if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(canonicalJson(receipt)), key, Buffer.from(value.signature, "base64url")))
        throw new Unverified("proof receipt signature");
    } else if (value.signature) throw new Unverified("directory receipts do not assert a provider signature");
    return value;
  }

  /** Immutable operation receipts; exact repeats are safe, conflicting responses are refused. */
  async accept(raw: unknown): Promise<{ digest: string }> {
    const value = await this.checked(raw, true);
    const content = canonicalJson(value);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Unverified("proof receipt size");
    const path = proofReceiptPath(this.options.directory, value.receipt);
    await directory(this.options.directory, true);
    const parent = join(this.options.directory, binding(value.receipt));
    await directory(parent, true);
    const temporary = join(parent, `.${crypto.randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    try {
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await boundedFile(path) !== content)
          throw new Unverified("conflicting immutable proof receipt");
      }
    } finally { await unlink(temporary); }
    const dir = await open(parent, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    return { digest: `sha256:${sha256Hex(content)}` };
  }

  async collect(workspaceId: string, context: ProofEvidenceContext): Promise<BoundProofEvidence[]> {
    const target = { workspaceId, trailId: context.trail.id, rev: context.trail.rev, base: context.base, head: context.head };
    const parent = join(this.options.directory, binding(target));
    let files: string[];
    try {
      await directory(this.options.directory); await directory(parent);
      files = (await readdir(parent)).filter(path => path.endsWith(".json"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (files.length > 30 || files.some(file => !/^[a-f0-9]{64}\.json$/.test(file))) throw new Unverified("proof receipt index bound");
    const result: BoundProofEvidence[] = [];
    for (const name of files.sort()) {
      const value = await this.checked(JSON.parse(await boundedFile(join(parent, name))));
      const receipt = value.receipt;
      if (binding(receipt) !== binding(target) || proofReceiptPath(this.options.directory, receipt) !== join(parent, name))
        throw new Unverified("proof receipt exact revision and operation binding");
      result.push({ trailId: receipt.trailId, rev: receipt.rev, base: receipt.base, head: receipt.head,
        operationKey: receipt.operationKey, source: `${value.signature ? "signed" : "operator"}:${receipt.sourceId}`, items: receipt.items });
    }
    return result;
  }

  routes(): Hono {
    const app = new Hono();
    app.post("/callbacks/proof", bodyLimit({ maxSize: MAX_BYTES }), async c => {
      c.header("Cache-Control", "no-store");
      try { return c.json(await this.accept(await c.req.json()), 201); }
      catch { return c.json({ error: "Proof receipt signature, grant, or revision could not be verified." }, 422); }
    });
    return app;
  }
}
