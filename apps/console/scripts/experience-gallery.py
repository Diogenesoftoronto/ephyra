"""Package the inspected UI screenshots into a portable review gallery.
Run: uv run --with pillow python apps/console/scripts/experience-gallery.py
Only changes image encoding for the gallery; original verification PNGs remain unchanged.
"""
import base64
import io
import json
from pathlib import Path
from PIL import Image

out = Path(__file__).resolve().parents[1] / 'artifacts/experience'
screens = [
    ('signin', 'Sign in', 'A textured entrance, account sign-in and an optional token connection.'),
    ('onboarding', 'Set up', 'A focused repository form with explicit automation choices.'),
    ('setup-blocked', 'Setup progress', 'Recorded steps and blockers remain visible; no invented readiness.'),
    ('runs', 'Follow agents', 'Recognizable roles, recorded activity and exact engine identities.'),
    ('run', 'Inside a run', 'Live session access and an interactive visual shared through a real local stream with fictional agent output.'),
    ('team', 'Invite your team', 'Choose Viewer or Approver, share a single-use link and manage access.'),
    ('invitation', 'Accept an invitation', 'See the exact workspace and role before choosing to join.'),
]
images = {}
for name, _, _ in screens:
    for width in [390, 1440]:
        for scheme in ['light', 'dark']:
            source = (out.parent / 'run-handoff' if name == 'run' else out) / f'{name}-{width}-{scheme}.png'
            image = Image.open(source).convert('RGB')
            buffer = io.BytesIO()
            image.save(buffer, 'WEBP', quality=90, method=6)
            images[f'{name}-{width}-{scheme}'] = 'data:image/webp;base64,' + base64.b64encode(buffer.getvalue()).decode()
html = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ephyra · Experience review</title><style>
:root{color-scheme:light;font:16px/1.55 system-ui,sans-serif;background:#f6f3ea;color:#242a27}*{box-sizing:border-box}
body{margin:0}header,main,footer{max-width:1240px;margin:auto;padding:24px}header{padding-top:48px}h1{font-size:clamp(28px,4vw,48px);line-height:1.1;margin:12px 0}
p{margin:8px 0;max-width:75ch}.label{font:12px/1.5 ui-monospace,monospace;letter-spacing:.1em;color:#58675e}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:24px 0 16px}button,select{font:inherit;color:inherit;border:1px solid #b7bfb6;border-radius:9px;padding:10px 14px;background:#fff;cursor:pointer}
button[aria-pressed=true]{background:#203c37;color:#fff;border-color:#203c37}button:focus-visible,select:focus-visible{outline:3px solid #b97115;outline-offset:3px}
.controls{display:flex;gap:20px;flex-wrap:wrap;align-items:center}.controls label{display:flex;gap:10px;align-items:center}
figure{margin:24px 0 0;padding:16px;border:1px solid #c7cec3;border-radius:18px;background:#e7e9df;min-height:500px}
img{display:block;width:100%;height:auto;border-radius:8px;box-shadow:0 10px 40px #12201c20;margin:auto}
figure.phone img{max-width:390px}figcaption{font-size:14px;color:#44574c;margin-bottom:16px}footer{font-size:14px;border-top:1px solid #c7cec3}
@media(max-width:600px){header,main,footer{padding:20px}figure{padding:8px}nav{gap:6px}button{padding:9px 10px;font-size:14px}}
</style><header><div class="label">EPHYRA / EXPERIENCE REVIEW / NOVEMBER 8</div><h1>From signing in to working together.</h1>
<p>Textured glass, a clearer start, and a shared view of the work. These are screenshots of the implemented interface using fictional local test data.</p></header>
<main><nav aria-label="Screen"></nav><div class="controls"><label>Appearance <select id="theme" aria-label="Appearance"><option value="light">Light</option><option value="dark">Dark</option></select></label>
<label>Screen size <select id="size" aria-label="Screen size"><option value="1440">Desktop</option><option value="390">Phone</option></select></label></div>
<figure><figcaption id="caption"></figcaption><img id="screen" alt=""></figure></main>
<footer><p><strong>Verified locally:</strong> sign-in and automatic setup; Viewer/Approver invitation, joining, reload and revocation; 36 responsive fixture layouts; interrupted-write recovery; keyboard and motion fallbacks.</p>
<p>Run handoff checks cover streamed links, interactive visuals, expansion, revision updates, isolation and replay. Hosted accounts, live model work, deployed Convex and production deployment remain unverified.</p>
<p>The application now uses selected Ideogram persona tiles, FLUX illustrations and a short Kling entrance animation. Fifteen retained tile studies and the Kling/Wan comparisons are in the material-lab galleries. This is a visual record; the application code and tests are on <code>ui/jakub-console-polish</code>.</p></footer>
<script>
const screens=SCREENS, images=IMAGES;let selected='signin';
const nav=document.querySelector('nav'),theme=document.querySelector('#theme'),size=document.querySelector('#size'),picture=document.querySelector('#screen');
function render(){const entry=screens.find(x=>x[0]===selected);document.querySelector('#caption').textContent=entry[2];picture.src=images[`${selected}-${size.value}-${theme.value}`];picture.alt=`${entry[1]}, ${theme.value} appearance, ${size.value}px local fixture`;document.querySelector('figure').classList.toggle('phone',size.value==='390');for(const b of nav.children)b.setAttribute('aria-pressed',String(b.dataset.id===selected));}
for(const [id,label]of screens){const b=document.createElement('button');b.textContent=label;b.dataset.id=id;b.addEventListener('click',()=>{selected=id;render()});nav.append(b)}theme.addEventListener('change',render);size.addEventListener('change',render);render();
</script></html>'''
html = html.replace('SCREENS', json.dumps(screens)).replace('IMAGES', json.dumps(images))
(out / 'review.html').write_text(html)
print(f'Saved {out / "review.html"} ({len(html):,} bytes)')
