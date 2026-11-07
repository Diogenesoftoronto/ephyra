import { z } from "zod";
import { Unverified, type ExtractBackend, type DecideBackend } from "@ephyra/core";

export const Purpose = z.enum(["extract", "decide.triage", "decide.policy", "decide.watch"]);
export type Purpose = z.infer<typeof Purpose>;
export const BackendConfig = z.object({
  kind: z.string().regex(/^(notorganic|byok:.+|selfhosted:.+)$/), alias: z.string().min(1),
  endpoint: z.url(), credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  supports: z.array(z.enum(["noul", "choice", "score"])),
  expectedIdentities: z.array(z.string().min(1)).optional(),
  pricing: z.record(z.string(), z.number().nonnegative()).optional(),
});
export const RegistryConfig = z.object({ backends: z.array(BackendConfig), purposes: z.partialRecord(Purpose, z.string()) }).superRefine((config, ctx) => {
  const names = new Set<string>();
  for (const backend of config.backends) {
    if (names.has(backend.alias)) ctx.addIssue({ code: "custom", message: `duplicate alias: ${backend.alias}` });
    names.add(backend.alias);
  }
});
export type RegistryConfig = z.infer<typeof RegistryConfig>;
export class UnknownAlias extends Error {
  constructor(public readonly alias: string) { super(`Unknown backend alias: ${alias}`); this.name = "UnknownAlias"; }
}
export class Registry {
  readonly config: RegistryConfig;
  constructor(config: unknown, private readonly instances: ReadonlyMap<string, DecideBackend | ExtractBackend>) { this.config = RegistryConfig.parse(config); }
  resolve(purpose: Purpose): DecideBackend | ExtractBackend {
    const alias = this.config.purposes[purpose];
    if (!alias) throw new UnknownAlias(purpose);
    const configured = this.config.backends.find((backend) => backend.alias === alias);
    const backend = this.instances.get(alias);
    if (!configured || !backend) throw new UnknownAlias(alias);
    if (backend.kind !== configured.kind || backend.alias !== alias ||
      (purpose === "extract" ? !("extract" in backend) : !("decide" in backend))) {
      throw new Error(`Backend does not match registry: ${alias}`);
    }
    return backend;
  }
}
export interface AccessTokenProvider { getAccessToken(): Promise<string> }
export function defaultAccessTokenProvider(): AccessTokenProvider { throw new Unverified("notorganic product registration"); }

