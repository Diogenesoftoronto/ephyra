"""Run the explicitly requested fal image/video comparisons with resumable receipts.

rtk proxy uv run --with pillow python apps/console/scripts/generate-media-experiments.py --live
Generated inputs are project artwork only. Credential remains in memory.
"""
import base64
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
SOURCE = ROOT / "site/_sources/media-experiments-2026-11-08"
OUTPUT = ROOT / "apps/console/public/materials/experiments"
SOURCE.mkdir(parents=True, exist_ok=True)
OUTPUT.mkdir(parents=True, exist_ok=True)
specs = json.loads(pathlib.Path(__file__).with_name("media-experiments.json").read_text())
only = next((arg[7:] for arg in sys.argv if arg.startswith("--only=")), None)
if only:
    specs = [spec for spec in specs if spec["id"] == only]
    if not specs:
        raise SystemExit("Unknown experiment id; no jobs submitted.")
credential = subprocess.run(["rtk", "proxy", "skate", "get", "fal_api_key@secrets"],
                            capture_output=True, check=True).stdout.decode().strip()
if not credential or "\n" in credential:
    raise SystemExit("Stored credential unavailable.")


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
        raise SystemExit(f"Provider request stopped ({type(error).__name__}); saved receipt must be reconciled before resubmission.") from None


for spec in specs:
    name = spec["id"]
    request = dict(spec["input"])
    if "reference" in spec:
        data = "data:image/png;base64," + base64.b64encode((ROOT / spec["reference"]).read_bytes()).decode()
        for field in spec["referenceFields"]:
            request[field] = data
    receipt_path = SOURCE / f"{name}.queue.json"
    result_path = SOURCE / f"{name}.result.json"
    prompt_path = SOURCE / f"{name}.prompt.json"
    if prompt_path.exists() and json.loads(prompt_path.read_text()) != spec:
        raise SystemExit("Saved request differs. Use a new experiment id; no job was submitted.")
    prompt_path.write_text(json.dumps(spec, indent=2))
    if not receipt_path.exists():
        receipt_path.write_text(json.dumps({"state": "submission-uncertain", "model": spec["model"]}))
        receipt = provider("https://queue.fal.run/" + spec["model"], request)
        receipt_path.write_text(json.dumps(receipt, indent=2))
    receipt = json.loads(receipt_path.read_text())
    if "request_id" not in receipt:
        raise SystemExit("Uncertain submission: reconcile the saved operation before creating any further jobs.")
    print(name + ": " + receipt["request_id"], flush=True)
    if result_path.exists():
        result = json.loads(result_path.read_text())
    else:
        for _ in range(300):
            status = provider(receipt["status_url"])
            if status["status"] == "COMPLETED":
                break
            time.sleep(3)
        else:
            raise SystemExit("Still pending. Receipt saved; resume without resubmitting.")
        result = provider(receipt["response_url"])
        result_path.write_text(json.dumps(result, indent=2))
    is_video = spec["kind"] == "video"
    source = SOURCE / (name + (".mp4" if is_video else ".png"))
    if not source.exists():
        url = result["video"]["url"] if is_video else result["images"][0]["url"]
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".fal.media"):
            raise SystemExit("Unexpected media host; result saved for inspection.")
        with urllib.request.urlopen(url, timeout=60) as response:
            source.write_bytes(response.read())
    if is_video:
        output = OUTPUT / f"{name}.mp4"
        if not output.exists():
            subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-i", str(source), "-an", "-vf", "scale=640:-2",
                            "-c:v", "libx264", "-crf", "26", "-preset", "slow", "-pix_fmt", "yuv420p",
                            "-movflags", "+faststart", str(output)], check=True)
        poster = OUTPUT / f"{name}.webp"
        webm = OUTPUT / f"{name}.webm"
        if not webm.exists():
            subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-i", str(output), "-an",
                            "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-cpu-used", "4", str(webm)], check=True)
        if not poster.exists():
            subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-i", str(source), "-frames:v", "1",
                            "-vf", "scale=640:-2", str(poster)], check=True)
    else:
        output = OUTPUT / f"{name}.webp"
        Image.open(source).convert("RGB").save(output, "WEBP", quality=88, method=6)
    manifest_path = OUTPUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"assets": {}}
    prior = manifest["assets"].get(name, {})
    manifest["assets"][name] = {**spec, "file": output.name, "requestId": receipt["request_id"],
                               "seed": result.get("seed"), "actualCost": None, "review": prior.get("review", "unreviewed"),
                               "selected": prior.get("selected", False), "reviewNote": prior.get("reviewNote"),
                               "operation": "Video: 640px H264 CRF26 and VP9 CRF38, audio removed. Image: WebP encoding only."}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(name + ": saved for visual review", flush=True)
