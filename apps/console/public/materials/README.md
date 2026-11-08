# Ephyra material studies

Generated on November 8, 2026, following the existing amber-glass identity. These are decorative assets, not agent
activity or evidence. The application serves them locally and makes no generation requests.

## Models and decisions

| Model endpoint | Experiment | Selected use |
| --- | --- | --- |
| [Ideogram v4 tiling](https://fal.ai/models/ideogram/v4/tiling) | Sixteen distinct prompts; fifteen usable outputs, one rejected gray result | Shell, introductory materials and six persona textures |
| [FLUX 2 Flash](https://fal.ai/models/fal-ai/flux-2/flash) | Two glass illustrations | Onboarding path and decorative team gathering |
| [Kling 3 Standard](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video) | Two five-second motion briefs | The stronger flowing-glass pass plays once on introductory scenes |
| [Wan 2.6](https://fal.ai/models/wan/v2.6/image-to-video) | Same amber reference, restrained motion | Comparison only; too subtle at application opacity |

The initial Kling study used the same start and end reference. The selected follow-up used a stronger brief and only
the starting frame. These are creative experiments, not a controlled model benchmark. The selected movie is not
treated as a seamless loop. The gathering illustration contains seven stones despite the six-stone prompt; it does
not represent a member or agent count. Approval labels in manifests record the assistant's visual review.

## Persona selection

| Role | Selected study | Material |
| --- | --- | --- |
| Rho | `04-rho-ripples` | Teal sensory ripples |
| Bell | `07-bell-strata` | Warm translucent strata |
| Nema | `08-nema-lattice` | Rose lattice |
| Lappet | `10-lappet-weave` | Sage woven fibers |
| Turri | `12-turri-tides` | Coral tidal lines |
| Velum | `14-velum-marbling` | Blue marbling |

`03-pearl-vellum`, `02-tidal-slate` and `01-honeyglass` supply the day, night and honey materials.
Tiles are resized as complete squares, never cropped, so their original edge relationship is preserved.
The UI combines them with opaque reading surfaces and provides a forced-colors fallback.

## Provenance and reproduction

- `exploration/manifest.json` records all sixteen tile attempts, including the rejected result with no public file.
- `selected-manifest.json` maps the selected 512px WebP exports to their source studies.
- `experiments/manifest.json` records image/video prompts, requested endpoints, request IDs, returned seeds and decisions.
- The older `manifest.json` records the initial site-material reuse and rejected trial; it is historical.
- Raw provider output and credential-free queue receipts remain in ignored `site/_sources/` directories.
  Credentials are read from `skate` into process memory and are never included in these files.

`scripts/tiling-variations.json` and `scripts/media-experiments.json` contain the experiment inputs.
Their `generate-*.py` scripts require `--live` for paid provider calls, run sequentially, save submission receipts,
resume known jobs and stop on ambiguous submissions. A changed prompt requires a new experiment ID.
Use the scripts only when a new paid run is intended. Recorded actual cost is `null`; billing has not been verified.

From the repository root, the following commands only rebuild local exports and galleries:

```sh
rtk proxy uv run --python /usr/bin/python3 --with pillow python apps/console/scripts/export-selected-materials.py
rtk proxy python apps/console/scripts/tiling-gallery.py
rtk proxy python apps/console/scripts/media-gallery.py
```

The self-contained HTML files go to `apps/console/artifacts/material-lab/`. The media gallery needs `ffmpeg` and includes
application screenshots when present. Its lightweight attachment uses 480px movie previews; app movies are 640px
H264/VP9 without audio. The film's timing and content are unchanged. The selected stills use WebP encoding.

## Verified and unverified

Local Chromium checks cover the galleries, actual video decoding, finite playback, pause/replay, offscreen suspension,
reduced motion, data-saving mode, failed-video stills, mobile bounds and both application themes. The image set and
movie frames were visually inspected. See [the experience review](../../EXPERIENCE-REVIEW.md) for the full scope.
Live production delivery, physical mobile performance, Safari/iOS and provider billing remain unverified.
