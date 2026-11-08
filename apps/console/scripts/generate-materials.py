"""Generate two candidate Ephyra materials through Ideogram v4 tiling on fal.

Reads the fal credential from skate in memory, never prints or saves it. A saved queue
receipt is resumed; an ambiguous submission is never retried automatically.
Run from the repository root: uv run --with pillow python apps/console/scripts/generate-materials.py
"""
import json
import pathlib
import subprocess
import time
import urllib.request
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE = ROOT / "site/_sources/console-materials"
OUTPUT = SOURCE / "candidates"
MODEL = "ideogram/v4/tiling"
PROMPTS = {
    "lagoon": "Seamless tileable macro material photograph, the surface of deeply tinted petroleum-blue translucent cast glass seen from above. A marine biology light table at night. Broad soft irregular water caustics and gentle flowing glass contours, tiny suspended microbubbles, delicate tactile satin grain. Very dark blue-green graphite base, sparse muted seafoam silver reflections and a trace of warm amber refracted light. Understated luxurious physical material, broad quiet fields, low contrast, even illumination with no focal point, no perspective, no horizon, no border, no text, no symbols, no illustration, no objects. All edges match seamlessly both horizontally and vertically. Not glitter, not neon, not marble, not a geometric pattern.",
    "lightbox": "Seamless tileable macro material photograph of pale champagne translucent cast glass on an illuminated marine biology light table. Broad gentle organic contours of clear gelatin, delicate satin microtexture, very fine dispersed air bubbles and faint soft refraction. Warm ivory and pale silver with restrained honey amber edges. Tactile softly lit physical material with quiet low contrast, light from below, even illumination across the whole image, no focal point, flat overhead view, no perspective, no horizon, no border, no text, no symbols, no objects. All edges match seamlessly horizontally and vertically. Not glitter, not stone marble, not a geometric pattern, no sharp veins.",
}
SOURCE.mkdir(parents=True, exist_ok=True)
OUTPUT.mkdir(parents=True, exist_ok=True)
credential = subprocess.run(["rtk", "proxy", "skate", "get", "fal_api_key@secrets"], capture_output=True, check=True).stdout.decode().strip()
if not credential or "\n" in credential:
    raise SystemExit("The stored fal credential is not usable.")

def call(url, body=None):
    request = urllib.request.Request(url, method="GET" if body is None else "POST")
    request.add_header("Authorization", "Key " + credential)
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, data=None if body is None else json.dumps(body).encode(), timeout=45) as response:
        return json.load(response)

for name, prompt in PROMPTS.items():
    receipt_path = SOURCE / (name + ".queue.json")
    result_path = SOURCE / (name + ".result.json")
    request = {"prompt": prompt, "image_size": "square_hd", "num_images": 1,
               "rendering_speed": "QUALITY", "expansion_model": "None", "tiling_mode": "both", "output_format": "png"}
    (SOURCE / (name + ".prompt.json")).write_text(json.dumps(request, indent=2))
    if not receipt_path.exists():
        receipt_path.write_text(json.dumps({"state": "submission-uncertain", "model": MODEL}))
        receipt = call("https://queue.fal.run/" + MODEL, request)
        receipt_path.write_text(json.dumps(receipt, indent=2))
    receipt = json.loads(receipt_path.read_text())
    if "request_id" not in receipt:
        raise SystemExit("Submission outcome is uncertain. Reconcile it before creating any further jobs.")
    print(name + ": request " + receipt["request_id"], flush=True)
    if result_path.exists():
        result = json.loads(result_path.read_text())
    else:
        for _ in range(90):
            status = call(receipt["status_url"])
            if status["status"] == "COMPLETED":
                break
            time.sleep(3)
        else:
            raise SystemExit("Generation is still pending. The queue receipt is saved; resume this script later.")
        result = call(receipt["response_url"])
        result_path.write_text(json.dumps(result, indent=2))
    url = result["images"][0]["url"]
    with urllib.request.urlopen(url, timeout=45) as response:
        (SOURCE / (name + ".png")).write_bytes(response.read())
    image = Image.open(SOURCE / (name + ".png")).convert("RGB")
    image.save(OUTPUT / (name + "-v1.webp"), "WEBP", quality=86, method=6)
    manifest_path = OUTPUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"model": MODEL, "assets": {}}
    manifest["assets"][name] = {"prompt": prompt, "requestId": receipt["request_id"], "seed": result.get("seed"),
                                "file": name + "-v1.webp", "width": image.width, "height": image.height,
                                "actualCost": None, "review": "unreviewed", "note": "Ideogram generated material; WebP encoding only. No runtime provider calls."}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(name + ": saved candidate WebP; visual review required before publication", flush=True)
