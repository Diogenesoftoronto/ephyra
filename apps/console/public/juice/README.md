# Character and sound studies

Completed on 2026-11-08: **22 video studies and six sound cues**. The application uses seven selected character
gestures. `/app/juice/experiments/index.html` is the full browsable comparison; it does not submit provider jobs.

Models researched and used:

- [H3 Max](https://fal.ai/models/minimax/h3-max/image-to-video/api): `minimax/h3-max/image-to-video`.
- [fal FLUX video](https://fal.ai/flux-video): `blackforestlabs/flux-3-max/image-to-video`.
- [Seedance 2.5](https://fal.ai/models/bytedance/seedance-2.5/image-to-video): `bytedance/seedance-2.5/image-to-video`.
- [Sonilo](https://fal.ai/explore/audio-models): `sonilo/v1.1/text-to-sound-effects`.

`experiments/manifest.json` records exact model identities, request IDs, prompts, reference assets, review notes and
uncompleted variants. `selection.json` records each application's source and derivation. Provider costs were not
returned, so actual cost is null. These subjective selections are not benchmark scores. Sound cues were decoded
and exercised in Chromium; no claim of human listening quality is made by those automated checks.

Ephyra uses H3 Max; Rho, Lappet and Turri use FLUX 3 Max; Bell and Velum use Seedance 2.5; Nema uses H3 Max.
Full comparisons preserve provider audio and start muted. Selected gestures remove audio and key the uniform black
matte to alpha at 480px. Ephyra and Rho omit the damaged first 0.2 seconds; other selected clips are not trimmed.
The gallery preserves the untrimmed provider comparisons. Five distributed frames and opening/closing frames were
inspected; finite playback and transparency are checked separately in the actual browser.

All six cues come from Sonilo. Comparison exports use -24 LUFS / -6 dBTP normalization; application derivatives add
an 8ms attack fade and 35ms release fade. Application playback is opt-in, throttled and at 35% volume. Touch, copy,
connection and invitation cues are wired to deliberate interactions or confirmed success. Message and attention
remain studies. Provider-native character audio is available only in the comparison gallery.

The restored fal balance ran out after the completed set. `rho-h3-max-png` was explicitly rejected with exhausted
balance; `rho-seedance-2.5-png` and `lappet-h3-max-funded` were not submitted. These are not completed experiments.

## Reproduce local exports

From the repository root, without provider calls:

```sh
python3 apps/console/scripts/export-juice.py
python3 apps/console/scripts/juice-gallery.py
```

The generator `scripts/generate-juice-experiments.py` is a separate paid operation. It reads the fal key from Skate
without logging it, records a credential-free submission receipt before polling, resumes completed requests, and
stops on uncertain submissions or rejected jobs. `--retry-rejected` is an explicit operator choice, never an automatic
retry. Original downloads and response receipts live in ignored `site/_sources/juice-2026-11-08/`; no credential is
included in this public directory. A page visit makes no provider call.

Reduced motion uses the approved still with no video request. Save-data and touch require explicit play. Background
tabs and offscreen characters pause. A decoded opaque frame falls back to the still. Real Safari/iOS decoding and
physical device performance remain unverified; Chromium checks do not establish them.
