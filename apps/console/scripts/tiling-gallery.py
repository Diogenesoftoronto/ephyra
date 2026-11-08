"""Build a local, self-contained tile comparison and a lightweight T3 HTML attachment source."""
import base64
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / "apps/console/public/materials/exploration"
OUT = ROOT / "apps/console/artifacts/material-lab"
OUT.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ASSETS / "manifest.json").read_text())
tiles = sorted((tile for tile in manifest["assets"].values() if tile["review"] != "rejected"), key=lambda x: x["id"])
prior = ROOT / "apps/console/public/materials"
data = [{key: tile[key] for key in ("id", "name", "persona", "idea", "prompt")} for tile in tiles]

page = r'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ephyra material studies</title><style>
:root{font-family:var(--font-sans,system-ui);color:var(--foreground);--gap:12px}
*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button,select{color:var(--foreground);background:var(--card);border:1px solid var(--border);border-radius:var(--radius,8px)}
button,select{min-height:36px;padding:7px 10px;cursor:pointer}button:hover{border-color:var(--primary)}:focus-visible{outline:2px solid var(--ring);outline-offset:3px}
p{margin:0;line-height:1.5}.subtle{font-size:12px;color:var(--foreground);opacity:.78}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.toolbar label{display:flex;gap:8px;align-items:center;font-size:13px}.toolbar select{max-width:100%}input[type=range]{width:100px;accent-color:var(--primary)}input[type=checkbox]{accent-color:var(--primary)}
.stage{--size:240px;--strength:1;--ground:#eeeee6;--type:#17312c;--plate:#fffdf5;--edge:#c4c9be;position:relative;isolation:isolate;overflow:hidden;border-radius:var(--radius,12px);min-height:300px;display:grid;place-items:center;padding:32px 22px;background:var(--ground);color:var(--type);border:1px solid var(--border)}
.stage[data-theme=dark]{--ground:#142421;--type:#eff1df;--plate:#17302c;--edge:#49645c}
.texture,.seams{position:absolute;inset:0;pointer-events:none}.texture{z-index:-2;background-image:var(--tile);background-size:var(--size);opacity:var(--strength)}
.seams{z-index:3;background-image:linear-gradient(90deg,#fb458bbf 1px,transparent 1px),linear-gradient(#fb458bbf 1px,transparent 1px);background-size:var(--size) var(--size)}
.sample{width:min(100%,420px);padding:22px;border:1px solid var(--edge);border-radius:16px;background:color-mix(in srgb,var(--plate) 96%,transparent);box-shadow:0 10px 40px #05231524}
.sample-head{display:flex;align-items:center;gap:14px;margin-bottom:14px}.sample img{width:56px;height:56px;object-fit:contain}.sample h2{font-size:24px;line-height:1.1;margin:3px 0;font-weight:620}.sample small{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.65}
.sample p{font-size:14px;max-width:35ch}.sample-bottom{display:flex;gap:10px;align-items:center;border-top:1px solid var(--edge);padding-top:14px;margin-top:18px;font-size:12px}.sample-bottom span:last-child{margin-left:auto;opacity:.6}
.selected{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:12px 0 18px}.selected strong{font-size:18px}.selected p{font-size:13px;flex-basis:100%;opacity:.78}.filter{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:0 0 12px}.filter label{font-size:13px;display:flex;gap:10px;align-items:center}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.tile{display:block;text-align:left;padding:0;overflow:hidden;min-width:0}.tile[aria-pressed=true]{outline:2px solid var(--primary);outline-offset:2px}.tile img{width:100%;height:115px;object-fit:cover;display:block}.tile span{display:block;padding:9px 10px;font-size:12px;line-height:1.3}.tile b{display:block;margin-top:2px;font-size:13px}.tile small{opacity:.7;font-size:10px;text-transform:uppercase;letter-spacing:.05em}.tile[hidden]{display:none}
details{margin:18px 0;font-size:12px}summary{cursor:pointer;padding:6px 0}details p{margin-top:8px}details a{color:var(--primary)}.old{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.old img{width:100%;height:100px;object-fit:cover;border-radius:var(--radius,8px)}.old figcaption{margin-top:6px;font-size:12px}figure{margin:0}
@media(max-width:480px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tile img{height:100px}.stage{min-height:300px;padding:20px 16px}.sample{padding:18px}.toolbar{gap:10px}.toolbar label{flex-wrap:wrap}.filter{align-items:start}.sample h2{font-size:22px}}
@media(forced-colors:active){.texture,.seams{display:none}.sample{background:Canvas;color:CanvasText}.tile[aria-pressed=true]{outline:2px solid Highlight}}
</style></head><body><main>
<div class="toolbar"><label>Repeat <input id="size" type="range" min="96" max="512" step="8" value="240"><output id="sizeValue">240px</output></label>
<label>Strength <input id="strength" type="range" min="5" max="100" value="100"><output id="strengthValue">100%</output></label>
<label>Surface <select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label>
<label><input type="checkbox" id="ui" checked> Show UI</label><label><input type="checkbox" id="grid"> Tile edges</label></div>
<div class="stage" id="stage" data-theme="light"><div class="texture"></div><div class="seams" id="seams" hidden></div>
<article class="sample" id="sample"><div class="sample-head"><img id="face" alt="" src="__PERSONA__"><div><small>Fictional interface example</small><h2 id="sampleName">A place to begin</h2><div id="role">Your Ephyra workspace</div></div></div>
<p id="sampleCopy">Follow the work, understand the evidence, and choose what happens next.</p><div class="sample-bottom"><span>Signal → evidence → proof</span><span>Material study</span></div></article></div>
<div class="selected" aria-live="polite"><strong id="name"></strong><span id="number" class="subtle"></span><p id="idea"></p></div>
<div class="filter"><span class="subtle">__COUNT__ new Ideogram tiles · select to compare</span><label>Show <select id="filter"><option value="all">All</option><option value="general">General surfaces</option><option>Rho</option><option>Bell</option><option>Nema</option><option>Lappet</option><option>Turri</option><option>Velum</option></select></label></div>
<div class="tiles">__TILES__</div>
<details><summary>Prompt and source for this tile</summary><p id="prompt"></p><p>Generated with <a href="https://fal.ai/models/ideogram/v4/tiling" target="_blank" rel="noreferrer">Ideogram v4 tiling on fal</a>. Original images; WebP encoding only. The interface sample above is fictional. Billing has not been independently verified.</p></details>
<details><summary>The two glass materials used before this exploration</summary><div class="old">__OLD__</div><p>These reused existing Ephyra artwork. The earlier two gray fal results were rejected.</p></details>
<div hidden>__FACES__</div>
</main><script>
const data=__DATA__;const $=id=>document.getElementById(id);const stage=$('stage');
const names={rho:['Rho','Listener','Hears production signals and helps decide what deserves a trail.'],bell:['Bell','Researcher','Gathers evidence and builds the hypothesis for your review.'],nema:['Nema','Prover','Builds a reproduction and checks whether the fix holds.'],lappet:['Lappet','Mender','Finds the smallest useful change and prepares a patch.'],turri:['Turri','Watcher','Watches what happens after a change lands.'],velum:['Velum','Scribe','Shapes your policy and intent documents with you.']};
function select(id){const t=data.find(x=>x.id===id);const button=document.querySelector('[data-id="'+id+'"]');if(!t||!button)return;
document.querySelectorAll('.tile').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));stage.style.setProperty('--tile','url("'+button.querySelector('img').src+'")');
$('name').textContent=t.name;$('number').textContent=String(data.indexOf(t)+1).padStart(2,'0')+' / '+data.length;$('idea').textContent=t.idea;$('prompt').textContent=t.prompt;
const persona=names[t.persona];$('sampleName').textContent=persona?persona[0]:'A place to begin';$('role').textContent=persona?persona[1]:'Your Ephyra workspace';$('sampleCopy').textContent=persona?persona[2]:'Follow the work, understand the evidence, and choose what happens next.';$('face').src=$('face-'+(t.persona||'bell')).src;}
document.querySelectorAll('.tile').forEach(button=>button.addEventListener('click',()=>select(button.dataset.id)));
$('size').oninput=e=>{stage.style.setProperty('--size',e.target.value+'px');$('sizeValue').textContent=e.target.value+'px'};
$('strength').oninput=e=>{stage.style.setProperty('--strength',e.target.value/100);$('strengthValue').textContent=e.target.value+'%'};
$('theme').onchange=e=>stage.dataset.theme=e.target.value;$('ui').onchange=e=>$('sample').hidden=!e.target.checked;$('grid').onchange=e=>$('seams').hidden=!e.target.checked;
$('filter').onchange=e=>{const filter=e.target.value.toLowerCase();document.querySelectorAll('.tile').forEach(button=>{button.hidden=filter!=='all'&&button.dataset.persona!==filter})};
select(data[0].id);
</script></body></html>'''


def image(path, inline):
    if inline:
        return "data:image/webp;base64," + base64.b64encode(path.read_bytes()).decode()
    return str(path)


for inline in (False, True):
    cards = []
    for tile in tiles:
        persona = tile["persona"] or "general"
        cards.append(f'<button class="tile" data-id="{tile["id"]}" data-persona="{persona}" aria-pressed="false">'
                     f'<img src="{image(ASSETS / tile["file"], inline)}" alt="{html.escape(tile["name"])} pattern">'
                     f'<span><small>{persona}</small><b>{html.escape(tile["name"])}</b></span></button>')
    faces = ''.join(f'<img id="face-{p}" alt="" src="{image(ROOT / f"apps/console/public/personas/{p}-64.webp", inline)}">'
                    for p in ["rho", "bell", "nema", "lappet", "turri", "velum"])
    old = ''.join(f'<figure><img alt="Existing {theme} glass" src="{image(prior / f"amber-glass-{theme}-v1.webp", inline)}">'
                  f'<figcaption>Existing {theme} glass</figcaption></figure>' for theme in ["light", "dark"])
    result = page.replace("__TILES__", ''.join(cards)).replace("__DATA__", json.dumps(data)).replace("__COUNT__", str(len(tiles)))
    result = result.replace("__FACES__", faces).replace("__OLD__", old)
    result = result.replace("__PERSONA__", image(ROOT / "apps/console/public/personas/bell-64.webp", inline))
    (OUT / ("tiles.html" if inline else "tiles-attachment.html")).write_text(result)
print(f"Built a comparison of {len(tiles)} tiles.")
