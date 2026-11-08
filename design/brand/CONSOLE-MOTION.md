# Console motion assets

The welcome and setup specimen uses a newly generated transparent illustration. Existing persona artwork is reused.
The interface keeps its open reading surfaces: no decorative cards, extra panels, or additional explanatory copy.

## Source and exports

- Built-in `image_gen` generated the amber still, using the existing hero and persona sheet as material references.
  Its complete prompt and provenance are in `apps/console/public/motion/manifest.json`.
- Original PNG: `design/brand/sources/ephyra-specimen-v1.png` (1254 × 1254, RGBA).
- Runtime poster: `apps/console/public/motion/ephyra-specimen-v1.webp` (512 × 512, alpha).
- Shareable loops: `apps/console/public/motion/ephyra-specimen-v1.gif` and `velum-refraction-v1.gif`.
  Each has a corresponding `-loop.webp`, with full alpha and smaller encoding.
- Velum's source remains the existing `apps/console/public/personas/velum.webp`.

The GIFs are 256 × 256, 42 frames at 20fps, 2.1-second seamless loops, under 1MB each.
The animation is rendered from the actual texture shader; image generation produced the still, not a fabricated video.
GIF transparency is binary. Animated WebP preserves soft alpha. The ordinary app doesn't autoplay either export.

Reproduce the exports from the repository root, with the installed Chromium and ffmpeg:

```sh
rtk proxy env -u LD_LIBRARY_PATH bun apps/console/scripts/export-jelly.ts
```

## Product behavior

`JellySpecimen` is an explicit small play interaction. Pointer entry, click, touch, or keyboard activation makes
the specimen refract briefly, then rest. It is neither a progress indicator nor evidence of a healthy deployment.
It sits beside the welcome/setup heading and never draws beneath text.

WebGL is lazy, limited to one small canvas on these routes, with no external library or provider request.
The renderer caps resolution at 384px and frame rate near 30fps. The still remains visible until a first frame exists.
Unavailable/lost WebGL, missing art, reduced motion, hidden tabs, and offscreen states retain readable ordinary UI.
Missing artwork falls back to the existing vector mark.

Persona avatars use their existing transparent art. Only recorded running work breathes continuously;
directory hover/focus plays a finite greeting. A pending drafting request uses Velum's same art in both themes.
Button presses preserve approximate volume, navigation icons tilt slightly, and the current setup step is an amber bead.
None of these changes delay or intercept account operations.

## Review and verification

All new states are in Storybook. `Motion/JellySpecimen/ShareableLoops` is paused initially and provides downloads.
`scripts/motion.ts` checks actual WebGL draws and their termination, keyboard, changing reduced-motion preferences,
offscreen suspension, simulated hidden tabs, unavailable/lost contexts, personas, and responsive layouts in Chromium.
`scripts/account-layout.ts` checks that the setup and Settings interactions continue to work.
Physical mobile GPU behavior and Safari remain unverified by these local checks.
