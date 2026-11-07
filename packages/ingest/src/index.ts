import { createHash } from "node:crypto";
import { Signal as SignalSchema, uuidv7, type Signal, type SignalStore, type StackFrame } from "@ephyra/core";

export function redact(s: string): string {
  return s.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b(?:sk-[\w-]+|ghp_[\w]+|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(/\b(?:password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED]");
}
export function parseStack(stack: string, repoRoot?: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    let m = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?\s*$/) || line.match(/^\s*File "([^"]+)", line (\d+), in (.+)$/);
    let file: string, fn: string | undefined, n: number, col: number | undefined;
    if (m && line.trim().startsWith("File ")) { file=m[1]!; n=+m[2]!; fn=m[3]; }
    else if (m) { fn=m[1]; file=m[2]!; n=+m[3]!; col=m[4] ? +m[4] : undefined; }
    else { m=line.match(/^\s*(?:(.*?)\s+at\s+)?(\S+\.(?:rs|go)):(\d+)(?::(\d+))?/); if (!m) continue; fn=m[1]; file=m[2]!; n=+m[3]!; col=m[4] ? +m[4] : undefined; }
    file=file.replace(/^file:\/\//, "");
    if (repoRoot && file.startsWith(repoRoot.replace(/\/$/, "") + "/")) file=file.slice(repoRoot.replace(/\/$/, "").length+1);
    const inApp=!/(?:node_modules|site-packages|\/rustc\/|\.cargo\/registry|\/pkg\/mod\/|\/go\/src\/|^node:|^<)/.test(file);
    frames.push({file: redact(file), fn: fn ? redact(fn) : undefined, line:n, column:col, inApp});
  }
  return frames;
}
export type Signalish = { exceptionType?: string; message?: string; frames?: StackFrame[] };
export function fingerprint(s: Signalish): string {
  const frames=(s.frames ?? []).filter(f=>f.inApp).slice(0,3);
  const normalized=(s.message ?? "").toLowerCase().replace(/https?:\/\/\S+/g,"<url>").replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g,"<email>").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g,"<uuid>").replace(/\b\d{4}-\d\d-\d\d(?:t\S+)?/g,"<time>").replace(/\b0x[0-9a-f]+\b/g,"<hex>").replace(/["'][^"']*["']/g,"<quoted>").replace(/(?:\/[\w.~-]+){2,}/g,"<path>").replace(/\d+/g,"<num>").replace(/\s+/g," ").trim();
  const data=frames.length ? [s.exceptionType ?? "", ...frames.map(f=>`${f.file}:${f.fn ?? ""}`)].join("\n") : `${s.exceptionType ?? ""}\n${normalized}`;
  return `v1:${createHash("sha256").update(data).digest("hex")}`;
}
export function toSignal(input: Signalish & {repo:string; environment?:string; service?:string; route?:string; traceId?:string; spanId?:string; at?:string; attributes?:Record<string,string>}): Signal {
  const frames=(input.frames ?? []).map(f=>({...f,file:redact(f.file),fn:f.fn ? redact(f.fn) : undefined}));
  const message=redact(input.message ?? "Error").slice(0,8000), exceptionType=input.exceptionType && redact(input.exceptionType);
  const at=input.at ?? new Date().toISOString();
  return SignalSchema.parse({schema:1,id:uuidv7(),kind:"error",repo:redact(input.repo),environment:redact(input.environment ?? "production"),service:input.service && redact(input.service),route:input.route && redact(input.route),fingerprint:fingerprint({message,exceptionType,frames}),title:(exceptionType || message).slice(0,300),message,exceptionType,frames,traceId:input.traceId,spanId:input.spanId,firstSeen:at,lastSeen:at,count:1,attributes:Object.fromEntries(Object.entries(input.attributes ?? {}).map(([k,v])=>[redact(k),redact(v)])),source:"otlp"});
}
export class MemorySignalStore implements SignalStore {
  private signals=new Map<string,Signal>(); private occurrences=new Map<string,{at:number; count:number}[]>(); private muted=new Map<string,number>(); private requests:{route:string; at:number; error:boolean}[]=[];
  async upsert(s:Signal) { const old=this.signals.get(s.fingerprint); const signal=old ? {...old,count:old.count+s.count,lastSeen:old.lastSeen>s.lastSeen?old.lastSeen:s.lastSeen,firstSeen:old.firstSeen<s.firstSeen?old.firstSeen:s.firstSeen} : structuredClone(s); this.signals.set(s.fingerprint,signal); const list=this.occurrences.get(s.fingerprint) ?? []; list.push({at:Date.parse(s.lastSeen),count:s.count}); this.occurrences.set(s.fingerprint,list); return {signal:structuredClone(signal),isNew:!old}; }
  async get(id:string) { return structuredClone([...this.signals.values()].find(s=>s.id===id) ?? null); }
  async byFingerprint(fp:string) { return structuredClone(this.signals.get(fp) ?? null); }
  async countSince(fp:string,since:Date) { return (this.occurrences.get(fp) ?? []).filter(x=>x.at>=+since).reduce((n,x)=>n+x.count,0); }
  async newFingerprintsInFiles(files:string[],since:Date) { return structuredClone([...this.signals.values()].filter(s=>Date.parse(s.firstSeen)>=+since && files.includes(s.frames.find(f=>f.inApp)?.file ?? ""))); }
  recordRequest(route:string,at:Date,error:boolean) { this.requests.push({route,at:+at,error}); }
  async errorRate(route:string,from:Date,to:Date) { const entries=this.requests.filter(x=>x.route===route && x.at>=+from && x.at<+to); return entries.length ? {requests:entries.length,errors:entries.filter(x=>x.error).length} : null; }
  async mute(fp:string,until:Date) { this.muted.set(fp,+until); }
  async isMuted(fp:string,at:Date) { return (this.muted.get(fp) ?? 0)>+at; }
}

// The transport is deliberately unavailable until durable deduplication and quota
// accounting can be bound to the caller identity and store transaction.
export { Unverified } from "@ephyra/core";
