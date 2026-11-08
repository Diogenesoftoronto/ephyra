"""Package the actual fal outputs and rendered app views into an offline comparison."""
import base64
import html
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / "apps/console/public/materials/experiments"
OUT = ROOT / "apps/console/artifacts/material-lab"
OUT.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ASSETS / "manifest.json").read_text())
image_refs = {}
video_refs = {}


def image(path):
    kind = "png" if path.suffix == ".png" else "webp"
    data = f"data:image/{kind};base64," + base64.b64encode(path.read_bytes()).decode()
    image_refs[data] = str(path)
    return data


def caption(asset):
    return f'<figcaption><strong>{html.escape(asset["name"])}</strong><p>{html.escape(asset["purpose"])}</p>' + \
        f'<small>{html.escape(asset["model"])} · {"Selected for the app" if asset.get("selected") else "Comparison study"}</small></figcaption>'


stills, movies = [], []
for asset in sorted(manifest["assets"].values(), key=lambda value: not value.get("selected", False)):
    if asset["kind"] == "image":
        stills.append(f'<figure><img src="{image(ASSETS / asset["file"])}" alt="{html.escape(asset["name"])}">{caption(asset)}</figure>')
    else:
        video = "data:video/webm;base64," + base64.b64encode((ASSETS / (asset["id"] + ".webm")).read_bytes()).decode()
        preview = OUT / (asset["id"] + ".preview.webm")
        source = ASSETS / (asset["id"] + ".webm")
        if not preview.exists() or preview.stat().st_mtime < source.stat().st_mtime:
            subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-y", "-i", str(source), "-an",
                            "-vf", "scale=480:-2", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "43",
                            "-cpu-used", "4", str(preview)], check=True)
        video_refs[video] = "data:video/webm;base64," + base64.b64encode(preview.read_bytes()).decode()
        movies.append(f'<figure><video controls muted playsinline preload="none" poster="{image(ASSETS / (asset["id"] + ".webp"))}" '
                      f'aria-label="{html.escape(asset["name"])} motion comparison"><source src="{video}" type="video/webm"></video>'
                      f'{caption(asset)}</figure>')
screens = []
for name, file in [("Sign in", "signin-390-dark.png"), ("Onboarding", "onboarding-1440-light.png"),
                   ("Agent materials", "runs-1440-dark.png"), ("QR invitation", "qr-approver-390-light.png")]:
    path = ROOT / "apps/console/artifacts/experience" / file
    if path.exists():
        screens.append(f'<option value="screen-{len(screens)}">{name}</option>')
screen_images = []
for index, file in enumerate(["signin-390-dark.png", "onboarding-1440-light.png", "runs-1440-dark.png", "qr-approver-390-light.png"]):
    path = ROOT / "apps/console/artifacts/experience" / file
    if path.exists():
        screen_images.append(f'<img id="screen-{index}" {"hidden" if index else ""} src="{image(path)}" alt="Rendered application fixture">')

page = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ephyra image and motion studies</title><style>
:root{font-family:var(--font-sans,system-ui);color:var(--foreground)}*{box-sizing:border-box}body{margin:0}
button,select{font:inherit;color:var(--foreground);background:var(--card);border:1px solid var(--border);border-radius:var(--radius,8px);padding:9px 12px;min-height:40px;cursor:pointer}
button[aria-pressed=true]{border-color:var(--primary);box-shadow:inset 0 -2px var(--primary)}:focus-visible{outline:2px solid var(--ring);outline-offset:3px}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid[hidden],section[hidden],img[hidden]{display:none}
figure{margin:0;min-width:0}figure img,video{width:100%;height:245px;object-fit:cover;border:1px solid var(--border);border-radius:var(--radius,12px);display:block;background:var(--secondary)}
figcaption{padding:12px 0}strong{display:block;font-size:16px}p{font-size:13px;line-height:1.6;margin:8px 0}small{display:block;font-size:11px;opacity:.75;overflow-wrap:anywhere}
.note{opacity:.8;font-size:12px;line-height:1.5;margin:4px 0 16px}.screens img{display:block;max-width:100%;height:620px;object-fit:contain;object-position:top left;margin-top:14px;border-radius:var(--radius,8px)}.screens img[hidden]{display:none}
.sources{margin-top:14px;font-size:12px}.sources a{color:var(--primary);margin-inline-end:12px}details{font-size:12px;margin-top:16px}summary{cursor:pointer}
@media(max-width:480px){.grid{grid-template-columns:1fr}.grid img,.grid video{height:250px}.screens img{height:auto;max-height:850px}.tabs button{padding:8px 10px;font-size:13px}}
</style></head><body><main>
<div class="tabs" aria-label="Media studies"><button data-panel="motion" aria-pressed="true">Motion · Kling / Wan</button><button data-panel="images" aria-pressed="false">Images · FLUX</button><button data-panel="app" aria-pressed="false">In the application</button></div>
<section id="motion"><p class="note">Kling and Wan, using the same amber source image. The initial light studies were too quiet; Living glass uses a stronger follow-up brief and is selected for the app. Press play to compare. Sound is removed; nothing autoplays here.</p><div class="grid">__MOVIES__</div></section>
<section id="images" hidden><p class="note">New still-image studies for onboarding and invitations. These illustrate the experience; they do not represent actual agent work.</p><div class="grid">__IMAGES__</div></section>
<section id="app" hidden class="screens"><p class="note">Rendered local application views with fictional test accounts and runs. The invitation pictured has already been consumed and revoked.</p><label>View <select id="screen">__OPTIONS__</select></label>__SCREENS__</section>
<div class="sources"><a href="https://fal.ai/models/fal-ai/flux-2/flash" target="_blank" rel="noreferrer">FLUX 2 Flash</a><a href="https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video" target="_blank" rel="noreferrer">Kling 3 Standard</a><a href="https://fal.ai/models/wan/v2.6/image-to-video" target="_blank" rel="noreferrer">Wan 2.6</a></div>
<details><summary>Generation and verification</summary><p>Actual fal outputs generated with saved prompts and credential-free request receipts. Videos are scaled to 640px and encoded without audio; no timing or content edits. Billing is not independently verified. The selected entrance animation plays once in the app, can be paused or replayed, and uses still artwork for reduced motion. Local browser evidence does not establish deployment or physical-camera scanning.</p></details>
</main><script>
document.querySelectorAll('[data-panel]').forEach(button=>button.onclick=()=>{document.querySelectorAll('video').forEach(video=>video.pause());document.querySelectorAll('[data-panel]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));['motion','images','app'].forEach(id=>document.getElementById(id).hidden=id!==button.dataset.panel)});
document.getElementById('screen').onchange=event=>document.querySelectorAll('.screens img').forEach(img=>img.hidden=img.id!==event.target.value);
</script></body></html>'''
page = page.replace("__MOVIES__", ''.join(movies)).replace("__IMAGES__", ''.join(stills))
page = page.replace("__OPTIONS__", ''.join(screens)).replace("__SCREENS__", ''.join(screen_images))
(OUT / "media.html").write_text(page)
attachment = page
for data, path in image_refs.items():
    attachment = attachment.replace(data, path)
for full, preview in video_refs.items():
    attachment = attachment.replace(full, preview)
attachment = attachment.replace("Videos are scaled to 640px", "Comparison previews are scaled to 480px; app videos to 640px")
if len(attachment) > 512000:
    raise SystemExit("Attachment exceeds the inline viewer limit; reduce preview encoding size.")
(OUT / "media-attachment.html").write_text(attachment)
print(f"Built {len(stills)} image and {len(movies)} video comparisons with application views.")
