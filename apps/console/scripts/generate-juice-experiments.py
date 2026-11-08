"""Resumable, sequential fal character and sound comparisons. Credentials stay in memory.

Run: rtk proxy python apps/console/scripts/generate-juice-experiments.py --live
Every paid submission has a persisted receipt. Ambiguous submissions stop, never retry.
"""
import base64
import io
import json
import pathlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request

if "--live" not in sys.argv:
    raise SystemExit("Pass --live to run the explicitly authorized paid experiment set.")
ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE = ROOT / "site/_sources/juice-2026-11-08"
OUTPUT = ROOT / "apps/console/public/juice/experiments"
SOURCE.mkdir(parents=True, exist_ok=True)
OUTPUT.mkdir(parents=True, exist_ok=True)
catalog = json.loads(pathlib.Path(__file__).with_name("juice-experiments.json").read_text())
specs = catalog["experiments"]
only = next((arg[7:] for arg in sys.argv if arg.startswith("--only=")), None)
retry_rejected = "--retry-rejected" in sys.argv
if only:
    specs = [s for s in specs if s["id"] in only.split(",")]
    if not specs:
        raise SystemExit("Unknown experiment id; nothing submitted.")
credential = subprocess.run(["rtk", "proxy", "skate", "get", "fal_api_key@secrets"],
                            capture_output=True, check=True).stdout.decode().strip()
if not credential or "\n" in credential:
    raise SystemExit("Stored credential unavailable.")


class BalanceRejected(Exception):
    """A definite provider rejection, not an ambiguous accepted job."""


def provider(url, body=None):
    if urllib.parse.urlsplit(url).netloc != "queue.fal.run" or not url.startswith("https://"):
        raise SystemExit("Unexpected queue origin; no credential sent.")
    request = urllib.request.Request(url, method="GET" if body is None else "POST")
    request.add_header("Authorization", "Key " + credential)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, data=None if body is None else json.dumps(body).encode(), timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace").replace(credential, "[redacted]")[:2000]
        (SOURCE / "last-http-error.json").write_text(json.dumps({"url": url, "status": error.code, "detail": detail}, indent=2))
        if error.code == 403 and "Exhausted balance" in detail:
            raise BalanceRejected("Provider rejected the request: exhausted balance.") from None
        raise SystemExit(f"Provider HTTP {error.code}; redacted detail saved. Reconcile the receipt before another submission.") from None
    except Exception as error:
        raise SystemExit(f"Provider request stopped ({type(error).__name__}); reconcile saved receipt before resubmission.") from None


def encode(source, output, args):
    if not output.exists():
        subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-i", str(source), *args, str(output)], check=True)


for spec in specs:
    name = spec["id"]
    request = dict(spec["input"])
    if "reference" in spec:
        path = ROOT / spec["reference"]
        mime = "image/webp" if path.suffix == ".webp" else "image/png"
        pixels = path.read_bytes()
        if spec.get("referenceBackground") == "black":
            from PIL import Image
            original = Image.open(io.BytesIO(pixels)).convert("RGBA")
            opaque = Image.new("RGBA", original.size, (0, 0, 0, 255))
            opaque.alpha_composite(original)
            buffer = io.BytesIO()
            opaque.convert("RGB").save(buffer, "PNG")
            pixels, mime = buffer.getvalue(), "image/png"
        data = f"data:{mime};base64," + base64.b64encode(pixels).decode()
        for field in spec["referenceFields"]:
            request[field] = data
    receipt_path = SOURCE / f"{name}.queue.json"
    result_path = SOURCE / f"{name}.result.json"
    prompt_path = SOURCE / f"{name}.prompt.json"
    if prompt_path.exists() and json.loads(prompt_path.read_text()) != spec:
        raise SystemExit("Saved request differs. Use a new experiment id; no job submitted.")
    prompt_path.write_text(json.dumps(spec, indent=2))
    previous_receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
    retry = retry_rejected and previous_receipt and previous_receipt.get("state") == "provider-rejected"
    if retry:
        history_path = SOURCE / f"{name}.rejected-attempts.json"
        history = json.loads(history_path.read_text()) if history_path.exists() else []
        history.append(previous_receipt)
        history_path.write_text(json.dumps(history, indent=2))
    if previous_receipt is None or retry:
        receipt_path.write_text(json.dumps({"state": "submission-uncertain", "model": spec["model"]}))
        try:
            response = provider("https://queue.fal.run/" + spec["model"], request)
        except BalanceRejected as error:
            receipt_path.write_text(json.dumps({"state": "provider-rejected", "model": spec["model"],
                                                "status": 403, "reason": "Exhausted balance", "at": time.time()}))
            raise SystemExit(str(error)) from None
        receipt_path.write_text(json.dumps(response, indent=2))
    receipt = json.loads(receipt_path.read_text())
    if "request_id" not in receipt:
        raise SystemExit("Uncertain submission. Reconcile this operation before creating further jobs.")
    print(name + ": " + receipt["request_id"], flush=True)
    if result_path.exists():
        result = json.loads(result_path.read_text())
    else:
        for _ in range(600):
            status = provider(receipt["status_url"])
            if status["status"] == "COMPLETED":
                break
            time.sleep(3)
        else:
            raise SystemExit("Still pending. Resume with saved receipt; do not resubmit.")
        result = provider(receipt["response_url"])
        result_path.write_text(json.dumps(result, indent=2))
    video = spec["kind"] == "video"
    source = SOURCE / (name + (".mp4" if video else ".wav"))
    if not source.exists():
        media = result["video"] if video else result.get("audio", result.get("audios", [None])[0])
        url = media["url"]
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".fal.media"):
            raise SystemExit("Unexpected media host; result saved for inspection.")
        with urllib.request.urlopen(url, timeout=120) as response:
            source.write_bytes(response.read())
    if video:
        output = OUTPUT / f"{name}.mp4"
        encode(source, output, ["-vf", "scale=640:-2", "-c:v", "libx264", "-crf", "27", "-preset", "fast",
                               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"])
        encode(source, OUTPUT / f"{name}.webm", ["-vf", "scale=480:-2", "-c:v", "libvpx-vp9", "-b:v", "0",
                                                "-crf", "40", "-cpu-used", "4", "-c:a", "libopus", "-b:a", "48k"])
        encode(source, OUTPUT / f"{name}.webp", ["-frames:v", "1", "-vf", "scale=480:-2"])
    else:
        output = OUTPUT / f"{name}.mp3"
        encode(source, output, ["-af", "loudnorm=I=-24:TP=-6:LRA=7", "-c:a", "libmp3lame", "-b:a", "128k"])
    manifest_path = OUTPUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"researchedAt": catalog["researchedAt"], "assets": {}}
    prior = manifest["assets"].get(name, {})
    manifest["assets"][name] = {**spec, "file": output.name, "requestId": receipt["request_id"],
                               "seed": result.get("seed"), "actualCost": None,
                               "review": prior.get("review", "unreviewed"), "selected": prior.get("selected", False),
                               "reviewNote": prior.get("reviewNote"),
                               "operation": "Video: 640px H264 and 480px VP9, provider audio preserved. Sound: MP3, -24 LUFS, -6 dBTP."}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(name + ": saved for review", flush=True)
