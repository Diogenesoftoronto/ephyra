"""Build the local media lab and a small self-contained conversation gallery. No provider calls."""
import base64
import html
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
PUBLIC = ROOT / "apps/console/public/juice"
OUT = ROOT / "apps/console/artifacts/juice"
OUT.mkdir(parents=True, exist_ok=True)
data = json.loads((PUBLIC / "experiments/manifest.json").read_text())
selection = json.loads((PUBLIC / "selection.json").read_text())
MODELS = {"minimax/h3-max/image-to-video": "H3 Max", "blackforestlabs/flux-3-max/image-to-video": "FLUX 3 Max",
          "bytedance/seedance-2.5/image-to-video": "Seedance 2.5", "sonilo/v1.1/text-to-sound-effects": "Sonilo 1.1"}

CSS = """
*{box-sizing:border-box}body{margin:0;font-family:var(--font-sans,system-ui);color:var(--foreground,CanvasText)}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}button,select{font:inherit;color:inherit;background:var(--secondary,ButtonFace);border:1px solid var(--border,ButtonBorder);border-radius:var(--radius,8px);padding:9px 12px;cursor:pointer;min-height:40px}
button[aria-pressed=true]{border-color:var(--primary,Highlight);box-shadow:inset 0 -2px var(--primary,Highlight)}
button:focus-visible,video:focus-visible,select:focus-visible{outline:2px solid var(--ring,Highlight);outline-offset:3px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}article{min-width:0;background:var(--card,Canvas);border:1px solid var(--border,ButtonBorder);border-radius:var(--radius,12px);padding:16px}
video{display:block;width:100%;aspect-ratio:1;object-fit:contain;border-radius:8px}.study video{background:#000}
h3{font-size:16px;margin:12px 0 5px}p{font-size:13px;line-height:1.5;margin:6px 0}small,code{font-size:11px;overflow-wrap:anywhere}small{color:var(--muted-foreground,GrayText)}
.sound-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.sound-grid button{padding:20px 12px;text-align:left}.sound-grid small{display:block;margin-top:6px}
.note{color:var(--muted-foreground,GrayText);font-size:12px;margin:14px 0}.status{min-height:22px}.hidden,[hidden]{display:none!important}
@media(max-width:540px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}article{padding:12px}.sound-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
"""
JS = """
let audio=null;
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{
 document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
 document.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==button.dataset.view);
 document.querySelectorAll('video').forEach(v=>v.pause());if(audio)audio.pause();
});
document.addEventListener('play',event=>{if(event.target.tagName==='VIDEO')document.querySelectorAll('video').forEach(v=>{if(v!==event.target)v.pause()})},true);
document.querySelectorAll('[data-sound]').forEach(button=>button.onclick=()=>{
 if(audio)audio.pause();audio=new Audio(button.dataset.sound);audio.volume=.35;
 const status=document.querySelector('.status');status.textContent='Playing '+button.dataset.cue;
 audio.onended=()=>status.textContent='';audio.play().catch(()=>status.textContent='Playback was blocked. Try the button again.');
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){document.querySelectorAll('video').forEach(v=>v.pause());if(audio)audio.pause()}});
const filter=document.querySelector('[data-filter]');if(filter)filter.onchange=()=>document.querySelectorAll('[data-panel="models"] [data-model]').forEach(card=>card.hidden=!!filter.value&&card.dataset.model!==filter.value);
"""

def embed(path, mime):
    return "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode()

def mini(name, source, alpha=False):
    target = OUT / (name + "-preview.webm")
    if not target.exists() or target.stat().st_mtime < source.stat().st_mtime:
        subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-y", *( ["-c:v", "libvpx-vp9"] if alpha else []), "-i", str(source), "-an",
                        "-vf", "fps=12,scale=160:-2", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "45", "-cpu-used", "4",
                        "-pix_fmt", "yuva420p" if alpha else "yuv420p", "-auto-alt-ref", "0", str(target)], check=True)
    return embed(target, "video/webm")

def poster(name, source, alpha=False):
    target = OUT / (name + "-poster.webp")
    if not target.exists() or target.stat().st_mtime < source.stat().st_mtime:
        subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-y", *( ["-c:v", "libvpx-vp9"] if alpha else []), "-ss", "0.2", "-i", str(source),
                        "-frames:v", "1", "-vf", "scale=120:-2", "-c:v", "libwebp", "-q:v", "35", str(target)], check=True)
    return embed(target, "image/webp")

def card(name, asset, source, label=None, selected=False, cover=""):
    title = label or (asset.get("persona", "Ephyra").title() + " · " + MODELS[asset["model"]])
    note = selection["characters"].get(label.lower(), {}).get("note", "") if label else asset.get("reviewNote", "")
    return f'<article class="{ "" if selected else "study"}" data-model="{html.escape(asset["model"])}"><video controls muted playsinline preload="none" poster="{cover}" aria-label="{html.escape(title)}" src="{source}"></video><h3>{html.escape(title)}</h3><small>{MODELS[asset["model"]]} · {"Selected gesture" if selected else asset["review"]}</small><p>{html.escape(note or "Same reference and gesture brief.")}</p></article>'

def document(inline):
    chosen = []
    for persona, item in selection["characters"].items():
        asset = data["assets"][item["experiment"]]
        source = mini(persona, PUBLIC / item["file"], True) if inline else "../" + item["file"]
        cover = poster(persona, PUBLIC / item["file"], True) if inline else "../../" + asset["reference"].split("public/")[1]
        chosen.append(card(item["experiment"], asset, source, persona.title(), True, cover))
    studies = []
    for name, asset in data["assets"].items():
        if asset["kind"] != "video": continue
        if inline and name not in ["ephyra-h3-max", "ephyra-flux-3-max-png", "ephyra-seedance-2.5-png"]: continue
        source = mini(name, PUBLIC / "experiments" / asset["file"]) if inline else asset["file"]
        cover = poster(name, PUBLIC / "experiments" / asset["file"]) if inline else name + ".webp"
        studies.append(card(name, asset, source, cover=cover))
    sounds = []
    for cue, item in selection["sounds"].items():
        source = embed(PUBLIC / item["file"], "audio/mpeg") if inline else "../" + item["file"]
        sounds.append(f'<button data-sound="{source}" data-cue="{cue}">{cue.title()}<small>Sonilo 1.1 · play cue</small></button>')
    options = ''.join(f'<option value="{key}">{value}</option>' for key, value in MODELS.items() if 'video' in key)
    filter_select = '' if inline else f'<label>Model <select data-filter><option value="">All models</option>{options}</select></label>'
    footer = ('Silent compact video previews. Sound cues play only when pressed. ' if inline else 'Full comparison exports retain provider audio; videos start muted. ')
    footer += '22 completed video studies · 6 sound cues. Three additional variants stopped when fal exhausted its balance. Costs are unreported by these receipts.'
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ephyra motion lab</title><style>' + CSS + '</style></head><body>' + \
      '<div class="controls" role="group" aria-label="Media studies"><button data-view="characters" aria-pressed="true">Seven companions</button><button data-view="models" aria-pressed="false">'+('Three models' if inline else 'All 22 comparisons')+'</button><button data-view="sounds" aria-pressed="false">Six sound cues</button></div>' + \
      '<section data-panel="characters"><div class="grid">'+''.join(chosen)+'</div></section>' + \
      '<section data-panel="models" hidden>'+filter_select+'<p class="note">Original transparent WebP inputs caused visible artifacts in some early studies. Later comparisons use an opaque black PNG reference.</p><div class="grid">'+''.join(studies)+'</div></section>' + \
      '<section data-panel="sounds" hidden><p>Quiet, short feedback for touch, copying, connections and invitations. Application sound is off until you choose it.</p><div class="sound-grid">'+''.join(sounds)+'</div><p class="status" role="status"></p></section><p class="note">'+footer+'</p><script>'+JS+'</script></body></html>'

(PUBLIC / "experiments/index.html").write_text(document(False))
inline = document(True)
(OUT / "juice-gallery-inline.html").write_text(inline)
print(json.dumps({"inlineBytes": len(inline.encode()), "fullGallery": str(PUBLIC / "experiments/index.html")}))
