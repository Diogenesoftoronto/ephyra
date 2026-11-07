#!/usr/bin/env bun
import { Client, inboxReducer, renderInbox, type InboxState, type Command } from "./index";
import { init } from "./init";
import { createCliRenderer, TextRenderable } from "@opentui/core";

async function execute(client: Client, cmd: Command) {
  const {item, action, note} = cmd;
  if (action === "approve" && item.kind === "spend") return client.spend(item.trailId, "approve");
  if (action === "approve" || action === "revise") return client.action(item.trailId, "decide", {checkpoint: item.checkpoint, verdict: action === "approve" ? "approve" : "revise", ...(note ? {note} : {})});
  if (action === "open" || action === "evidence") return client.show(item.trailId);
  return client.action(item.trailId, action, action === "comment" ? {text: note} : action === "kill" ? {reason: note} : {});
}
async function terminal(client: Client) {
  let state: InboxState = {items: await client.inbox(), selected: 0};
  const renderer = await createCliRenderer({exitOnCtrlC:true});
  const view = new TextRenderable(renderer, {content: renderInbox(state), width: "100%", height: "100%"});
  renderer.root.add(view);
  const draw = () => { view.content = renderInbox(state, renderer.width, renderer.height); };
  let busy = false;
  const refresh = async () => { if (busy || state.modal) return; try { state = {...state, items: await client.inbox(), error: undefined}; state.selected = Math.max(0,Math.min(state.selected,state.items.length-1)); } catch { state = {...state,error:"Refresh failed"}; } draw(); };
  const timer = setInterval(refresh, 30000);
  renderer.keyInput.on("keypress", async (key) => {
    if (key.name === "q" && !state.modal) { clearInterval(timer); renderer.destroy(); return; }
    const result = inboxReducer(state, key.name === "return" || key.name === "enter" ? "return" : key.name === "escape" || key.name === "backspace" ? key.name : key.sequence); state = result.state; draw();
    if (!result.command || busy) return;
    busy = true; const before = state;
    const cmd = result.command;
    if (["approve","kill","park"].includes(cmd.action)) state = {...state,items:state.items.filter(i => i !== cmd.item),selected:Math.max(0,Math.min(state.selected,state.items.length-2))};
    draw();
    try { const data = await execute(client,cmd); if (cmd.action === "open" || cmd.action === "evidence") state = {...state,error: JSON.stringify(data)}; }
    catch { state = {...before,error:"Action failed or outcome unknown; refresh before retrying"}; }
    busy = false; draw();
  });
}
async function main(args: string[]) {
  const json = args.includes("--json"); args = args.filter(a => a !== "--json");
  const cmd = args.shift();
  if (cmd === "init") { const remoteIndex = args.indexOf("--remote"); const remote = remoteIndex < 0 ? "origin" : args[remoteIndex+1]; const value = await init(process.cwd(), remote, args.includes("--force")); console.log(json ? JSON.stringify(value) : `Created: ${value.join(", ") || "none"}`); return; }
  if (!process.env.EPHYRA_URL || !process.env.EPHYRA_API_TOKEN) throw new Error("Set EPHYRA_URL and EPHYRA_API_TOKEN");
  const client = new Client(process.env.EPHYRA_URL, process.env.EPHYRA_API_TOKEN);
  let result: unknown;
  if (cmd === "status") result = await client.health();
  else if (cmd === "trails") { const i = args.indexOf("--state"); result = await client.trails(i < 0 ? undefined : args[i+1]); }
  else if (cmd === "inbox") { if (!json) return terminal(client); result = await client.inbox(); }
  else if (cmd === "show" && args[0]) result = await client.show(args[0]);
  else if (cmd === "decide" && args[0] && ["A","B","C"].includes(args[1] ?? "") && ["approve","revise","reject"].includes(args[2] ?? "")) { const i = args.indexOf("-m"); result = await client.action(args[0],"decide",{checkpoint:args[1],verdict:args[2], ...(i >= 0 ? {note:args[i+1]} : {})}); }
  else if (cmd && ["comment","claim","release","park","resume","kill","land"].includes(cmd) && args[0]) { const i = args.indexOf("-m"); if (["comment","kill"].includes(cmd) && (i < 0 || !args[i+1])) throw new Error(`${cmd} requires -m text`); result = await client.action(args[0],cmd,cmd === "comment" ? {text:args[i+1]} : cmd === "kill" ? {reason:args[i+1]} : {}); }
  else throw new Error("Usage: ephyra init|status|trails|show|decide|comment|claim|release|park|resume|kill|land|inbox");
  console.log(JSON.stringify(result,null,json ? 0 : 2));
}
main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : "Command failed"); process.exitCode = 1; });
