"""Explicit live Ideogram exploration. One saved job at a time; reruns resume receipts.

rtk proxy uv run --with pillow python apps/console/scripts/generate-tiling-variations.py --live [id ...]
No automatic resubmission after an ambiguous write or failed provider result.
"""
import json
import pathlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from PIL import Image

if "--live" not in sys.argv:
    raise SystemExit("This makes paid provider calls. Pass --live to run the authorized experiment set.")
ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE = ROOT / "site/_sources/tiling-variations-2026-11-08"
OUTPUT = ROOT / "apps/console/public/materials/exploration"
MODEL = "ideogram/v4/tiling"
specs = json.loads(pathlib.Path(__file__).with_name("tiling-variations.json").read_text())
requested_ids = [arg for arg in sys.argv[1:] if arg != "--live"]
if requested_ids:
    specs = [spec for spec in specs if spec["id"] in requested_ids]
    if len(specs) != len(set(requested_ids)):
        raise SystemExit("Unknown tile id; no jobs submitted.")
SOURCE.mkdir(parents=True, exist_ok=True)
OUTPUT.mkdir(parents=True, exist_ok=True)
credential = subprocess.run(["rtk", "proxy", "skate", "get", "fal_api_key@secrets"],
                            capture_output=True, check=True).stdout.decode().strip()
if not credential or "\n" in credential:
    raise SystemExit("The stored credential is not usable.")


def provider(url, body=None):
    if urllib.parse.urlsplit(url).netloc != "queue.fal.run" or not url.startswith("https://"):
        raise SystemExit("Unexpected queue origin; stopped before sending credentials.")
    request = urllib.request.Request(url, method="GET" if body is None else "POST")
    request.add_header("Authorization", "Key " + credential)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, data=None if body is None else json.dumps(body).encode(), timeout=45) as response:
            return json.load(response)
    except Exception as error:
        raise SystemExit(f"Provider request stopped ({type(error).__name__}); inspect the saved receipt before resuming.") from None


for spec in specs:
    name = spec["id"]
    receipt_path = SOURCE / f"{name}.queue.json"
    result_path = SOURCE / f"{name}.result.json"
    request = {"prompt": spec["prompt"], "image_size": "square_hd", "num_images": 1,
               "rendering_speed": "BALANCED", "expansion_model": "Large", "tiling_mode": "both", "output_format": "png"}
    prompt_path = SOURCE / f"{name}.prompt.json"
    if prompt_path.exists() and json.loads(prompt_path.read_text()) != request:
        raise SystemExit("Saved request differs from this prompt. Use a new variation id; no job was submitted.")
    prompt_path.write_text(json.dumps(request, indent=2))
    if not receipt_path.exists():
        receipt_path.write_text(json.dumps({"state": "submission-uncertain", "model": MODEL}))
        receipt = provider("https://queue.fal.run/" + MODEL, request)
        receipt_path.write_text(json.dumps(receipt, indent=2))
    receipt = json.loads(receipt_path.read_text())
    if "request_id" not in receipt:
        raise SystemExit("Uncertain submission: reconcile this saved operation before creating any further jobs.")
    print(name + ": " + receipt["request_id"], flush=True)
    if result_path.exists():
        result = json.loads(result_path.read_text())
    else:
        for _ in range(180):
            status = provider(receipt["status_url"])
            if status["status"] == "COMPLETED":
                break
            time.sleep(3)
        else:
            raise SystemExit("Still pending. Receipt saved; resume without resubmitting.")
        result = provider(receipt["response_url"])
        result_path.write_text(json.dumps(result, indent=2))
    source = SOURCE / f"{name}.png"
    if not source.exists():
        url = result["images"][0]["url"]
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".fal.media"):
            raise SystemExit("Unexpected media host; result saved for inspection.")
        with urllib.request.urlopen(url, timeout=45) as response:
            source.write_bytes(response.read())
    manifest_path = OUTPUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"model": MODEL, "assets": {}}
    prior = manifest["assets"].get(name, {})
    prior_review = prior.get("review", "unreviewed")
    image = Image.open(source).convert("RGB")
    public_file = None if prior_review == "rejected" else f"{name}.webp"
    if public_file:
        image.save(OUTPUT / public_file, "WEBP", quality=88, method=6)
    manifest["assets"][name] = {**spec, "file": public_file, "requestId": receipt["request_id"],
                               "seed": result.get("seed"), "width": image.width, "height": image.height,
                               "request": request, "actualCost": None, "review": prior_review,
                               "reviewNote": prior.get("reviewNote"),
                               "operation": "Original provider PNG encoded to WebP only; no creative alteration."}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(name + ": saved for visual review", flush=True)
