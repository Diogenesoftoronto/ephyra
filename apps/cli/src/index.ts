import type { InboxItem, Trail, TrailEvent } from "@ephyra/core";

export type Detail = { trail: Trail; events: TrailEvent[] };
export class Client {
  constructor(readonly url: string, readonly token: string, readonly fetcher: typeof fetch = fetch) {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string,string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) { headers["Content-Type"] = "application/json"; headers["Idempotency-Key"] = crypto.randomUUID(); }
    const res = await this.fetcher(new URL(path, this.url), { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw new Error(`API request failed (${res.status})`);
    return await res.json() as T;
  }
  health() { return this.request<unknown>("/healthz"); }
  inbox() { return this.request<InboxItem[]>("/v1/inbox"); }
  trails(state?: string) { return this.request<Trail[]>(`/v1/trails${state ? `?state=${encodeURIComponent(state)}` : ""}`); }
  show(id: string) { return this.request<Detail>(`/v1/trails/${encodeURIComponent(id)}`); }
  action(id: string, action: string, body: unknown = {}) { return this.request<unknown>(`/v1/trails/${encodeURIComponent(id)}/${action}`, body); }
  spend(id: string, verdict: string, note?: string) { return this.request<unknown>(`/v1/spend/${encodeURIComponent(id)}/decide`, { verdict, ...(note ? {note} : {}) }); }
}
export type Command = { action: string; item: InboxItem; note?: string };
export type InboxState = { items: InboxItem[]; selected: number; modal?: { action: string; value: string }; error?: string };
export function inboxReducer(state: InboxState, key: string): { state: InboxState; command?: Command } {
  const item = state.items[state.selected];
  if (state.modal) {
    if (key === "escape") return {state: {...state, modal: undefined}};
    if (key === "backspace") return {state: {...state, modal: {...state.modal, value: state.modal.value.slice(0,-1)}}};
    if (key === "return") {
      if (!item || !state.modal.value.trim()) return {state};
      return {state: {...state, modal: undefined}, command: {action: state.modal.action, item, note: state.modal.value}};
    }
    return {state: {...state, modal: {...state.modal, value: state.modal.value + (key.length === 1 ? key : "")}}};
  }
  if (key === "j" || key === "k") return {state: {...state, selected: Math.max(0, Math.min(state.items.length - 1, state.selected + (key === "j" ? 1 : -1)))}};
  if (!item) return {state};
  if ((key === "r" && item.kind === "checkpoint") || key === "c" || key === "x") return {state: {...state, modal: {action: key === "r" ? "revise" : key === "c" ? "comment" : "kill", value: ""}}};
  const action = key === "a" && (item.kind === "checkpoint" || item.kind === "spend") ? "approve" : key === "t" ? "claim" : key === "p" ? (item.kind === "parked" ? "resume" : "park") : key === "l" ? "land" : key === "o" ? "open" : key === "e" ? "evidence" : undefined;
  return action ? {state, command: {action, item}} : {state};
}
export function renderInbox(state: InboxState, width = 80, height = 24): string {
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  const lines = ["EPHYRA  /  INBOX", "j/k move  a approve  r revise  x kill  c comment  t claim  p park  o open  l land  e evidence", "", ...state.items.flatMap((i,n) => [`${n === state.selected ? ">" : " "} ${i.short}  sev ${i.severity}  ${i.area}  ${i.risk}  ${i.checkpoint ?? i.kind}  ${i.blocking ? "blocking" : "advisory"}${i.shadowVerdict === "approve" ? "  would auto-approve" : ""}`, `  ${i.title}: ${i.artefact.summary}`]), ...(state.error ? [`Error: ${state.error}`] : []), ...(state.modal ? [`${state.modal.action}: ${state.modal.value}`] : [])];
  return lines.slice(0,height).map(s => clean(s).slice(0,width)).join("\n");
}
export { init } from "./init";
