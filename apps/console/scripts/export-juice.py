"""Export reviewed gestures from completed provider receipts, without submitting jobs."""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
PUBLIC = ROOT / "apps/console/public/juice"
manifest = json.loads((PUBLIC / "experiments/manifest.json").read_text())
choices = {
    "ephyra": ("ephyra-h3-max", "Clear contraction and reopening; clean silhouette."),
    "rho": ("rho-flux-3-max", "Preserves the green tendril and its small leaning gesture."),
    "bell": ("bell-seedance-2.5", "Gentle compression stays inside the frame; the FLUX bounce clips the bell."),
    "nema": ("nema-h3-max", "An expressive turn that preserves the spiral body."),
    "lappet": ("lappet-flux-3-max", "A readable folding gesture; less shape change than the Seedance flower-like curl."),
    "turri": ("turri-flux-3-max", "A visible tail stretch with the inner jelly preserved."),
    "velum": ("velum-seedance-2.5", "The translucent disc curls and settles without leaving the frame."),
}
(PUBLIC / "characters").mkdir(exist_ok=True)
selected = {"reviewMethod": "Five evenly spaced frames plus opening/closing frame review, visual silhouette review, and browser decoding/playback checks. Subjective design selections, not model benchmark scores.", "characters": {}, "sounds": {}}
for persona, (name, note) in choices.items():
    asset = manifest["assets"][name]
    destination = PUBLIC / "characters" / (persona + ".webm")
    # The first frames of these transparent-WebP inputs contain provider artifacts; the following frames are clean.
    trim = 0.2 if persona in {"ephyra", "rho"} else 0
    subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-y", "-ss", str(trim), "-i", str(PUBLIC / "experiments" / asset["file"]), "-an",
                    "-vf", "format=rgba,colorkey=0x000000:0.08:0.12,scale=480:-2,format=yuva420p",
                    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-cpu-used", "4", "-auto-alt-ref", "0", str(destination)], check=True)
    selected["characters"][persona] = {"experiment": name, "model": asset["model"], "requestId": asset["requestId"],
        "file": "characters/" + destination.name, "note": note,
        "trimStartSeconds": trim,
        "derivation": f"Black matte keyed to alpha; silent VP9, 480px. Opening {trim}s removed; no speed change or generation."}
for cue in ["touch", "copy", "connected", "invitation", "message", "attention"]:
    name = "sound-" + cue + "-sonilo" + ("-funded" if cue == "touch" else "")
    asset = manifest["assets"][name]
    source = PUBLIC / "experiments" / asset["file"]
    duration = float(subprocess.check_output(["rtk", "proxy", "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(source)], text=True))
    subprocess.run(["rtk", "proxy", "ffmpeg", "-v", "error", "-y", "-i", str(source),
        "-af", f"afade=t=in:st=0:d=0.008,afade=t=out:st={max(0, duration - 0.035)}:d=0.035",
        "-c:a", "libmp3lame", "-b:a", "128k", str(PUBLIC / "sounds" / (cue + ".mp3"))], check=True)
    selected["sounds"][cue] = {"experiment": name, "model": asset["model"], "requestId": asset["requestId"],
        "file": "sounds/" + cue + ".mp3", "derivation": "-24 LUFS, -6 dBTP, 8ms attack fade and 35ms release fade. Playback at 35% volume, opt-in."}
(PUBLIC / "selection.json").write_text(json.dumps(selected, indent=2) + "\n")
print("Exported seven reviewed character gestures and recorded six sound sources.")
