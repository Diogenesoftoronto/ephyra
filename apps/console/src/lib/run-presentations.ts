import type { AgentRun, AgentRunEvent, RunVisual } from "@ephyra/core";

export function runLink(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* An unreported or malformed address is not a usable connection. */ }
}

export function runThreadLabel(run: Pick<AgentRun, "executor">): string {
  return run.executor.kind === "orb" ? "Open Amp orb" : run.executor.kind === "runner" ? "Open agent session" : "Open agent thread";
}

export type SavedVisual = { visual: RunVisual; seq: number; at: string };
export function runPresentations(run: AgentRun, events: readonly AgentRunEvent[]) {
  const visuals = new Map<string, SavedVisual>();
  const portals = new Set<string>();
  const primary = runLink(run.executor.portalUrl);
  if (primary) portals.add(primary);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.runId !== run.id) continue;
    if (event.visual) visuals.set(event.visual.id, { visual: event.visual, seq: event.seq, at: event.at });
    const url = event.type === "portal" ? runLink(event.portalUrl) : undefined;
    if (url) portals.add(url);
  }
  return { visuals: [...visuals.values()].sort((a, b) => b.seq - a.seq), portals: [...portals] };
}

/** An opaque-origin frame. Agent HTML has no app credentials, network API or authority to send messages. */
export function visualDocument(html: string): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
    + "media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark;--background:#faf8f3;--foreground:#222;--card:#fff;--border:#888;--accent:#be7023;
--font-sans:system-ui,sans-serif;--font-mono:monospace}*{box-sizing:border-box}html{overflow-wrap:anywhere}
body{margin:0;padding:16px;font-family:var(--font-sans);color:var(--foreground);background:transparent}
img,video,svg,canvas{max-width:100%}button,input,select{font:inherit}a{color:var(--accent)}</style>
<script>
addEventListener('message',function(e){if(e.source!==parent||e.data?.type!=='ephyra:visual-theme')return;
for(const [key,value] of Object.entries(e.data.variables||{})){if(/^--[a-z-]+$/.test(key)&&typeof value==='string')
document.documentElement.style.setProperty(key,value)}document.documentElement.style.colorScheme=e.data.scheme==='dark'?'dark':'light'});
addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage({type:'ephyra:visual-escape'},'*')});
addEventListener('DOMContentLoaded',function(){let pending=false;const measure=()=>{if(pending)return;pending=true;
requestAnimationFrame(()=>{pending=false;parent.postMessage({type:'ephyra:visual-size',height:document.documentElement.scrollHeight},'*')})};
new ResizeObserver(measure).observe(document.body);measure()});
</script></head><body>${html}</body></html>`;
}
