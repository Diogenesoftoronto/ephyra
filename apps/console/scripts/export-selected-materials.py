"""Encode visually approved patterns at UI size, preserving the complete original tile."""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
MATERIALS = ROOT / "apps/console/public/materials"
SOURCE = MATERIALS / "exploration"
manifest = json.loads((SOURCE / "manifest.json").read_text())
selections = {
    "day-v2.webp": "03-pearl-vellum",
    "night-v2.webp": "02-tidal-slate",
    "honey-v2.webp": "01-honeyglass",
    "personas/rho.webp": "04-rho-ripples",
    "personas/bell.webp": "07-bell-strata",
    "personas/nema.webp": "08-nema-lattice",
    "personas/lappet.webp": "10-lappet-weave",
    "personas/turri.webp": "12-turri-tides",
    "personas/velum.webp": "14-velum-marbling",
}
for tile in selections.values():
    if manifest["assets"].get(tile, {}).get("review") != "approved":
        raise SystemExit(f"{tile} still needs visual review; nothing exported.")
exports = []
for target, name in selections.items():
    asset = manifest["assets"][name]
    output = MATERIALS / target
    output.parent.mkdir(parents=True, exist_ok=True)
    image = Image.open(SOURCE / asset["file"]).convert("RGB")
    image.thumbnail((512, 512), Image.Resampling.LANCZOS)
    image.save(output, "WEBP", quality=88, method=6)
    exports.append({"file": target, "source": "exploration/" + asset["file"], "requestId": asset["requestId"],
                    "persona": asset["persona"], "operation": "Complete tile resized to 512px and WebP encoded; no crop or recoloring."})
(MATERIALS / "selected-manifest.json").write_text(json.dumps({"model": manifest["model"], "assets": exports}, indent=2) + "\n")
print(f"Exported {len(exports)} reviewed materials.")
