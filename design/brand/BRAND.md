# Ephyra brand and asset brief (v0, 2026-11-06)

Opus is the art director. **Fable** builds the landing page. **Astra** makes the logo, the icons and the GIF/motion pieces. **Opus** generates the raster images and video (GPT Image 2.6 and Seedance via fal), then integrates everything and runs QA. Everyone works from this file. If you disagree with a decision, write it in your report; don't silently deviate.

## 1. What we're selling

Ephyra is open-source, self-hostable **self-driving software**. It turns production errors, intent drift, regressions and its own bug-hunting into **trails**: durable, PR-less units of work (signal → evidence → repro → patch → proof → landing → watch) that live in git and land on Radicle, Tangled, plain git or a Sapling stack. Cheap System One models triage; humans approve at checkpoints. Not Organic is the account layer and voxq gathers human evidence. The philosophy is **jellyware**: software soft enough to reshape itself and firm enough to trust. Read `README.md` and `design/0*.md` for the substance.

Status is **design stage / pre-alpha**. Never imply it ships today, never invent users, testimonials, logos of customers, stars or benchmarks. Call to action: read the design, follow along, run it later.

## 2. The idea in one image

> **Honey jelly on a lightbox.** Amber gelatin, backlit, wobbling on a marine-biology lab bench at night. A tiny star-shaped ephyra (a baby jellyfish) pulses inside it.

An **ephyra** is the juvenile, free-swimming stage of a jellyfish: about 2 mm across, translucent, with eight arms that each end in two notched lappets. It swims by contracting its bell: a quick contraction (~0.35 s), then a slow relax (~1.1 s). That rhythm is our motion signature.

The lane is **specimen lab × gelatin dessert**. Picture a 1960s gelatin-mould cookbook photograph crossed with a marine-biology specimen plate. Precise, scientific framing; soft, edible, wobbly matter. It is *not* the cyberpunk-neon jellyfish cliché, *not* the purple-to-blue SaaS gradient, and *not* the editorial serif-plus-mono lane.

Three physical-object words: **gelatinous, lit-from-behind, exacting.**

## 3. Color (OKLCH)

Dark is the hero theme (lamplight in a dark room); light ("lightbox paper") must be just as finished. Define every token on bare `:root` first.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `oklch(0.975 0.012 85)` warm lightbox paper | `oklch(0.165 0.022 250)` deep-sea ink | page |
| `--surface` | `oklch(0.945 0.02 82)` | `oklch(0.215 0.026 248)` | panels, cards |
| `--ink` | `oklch(0.24 0.03 60)` | `oklch(0.95 0.015 85)` | body text |
| `--muted` | `oklch(0.45 0.03 65)` | `oklch(0.74 0.025 80)` | secondary text (must still hit 4.5:1) |
| `--jelly` | `oklch(0.74 0.162 68)` honey amber (the seed) | same | brand, the gelatin; fills and glows, **not body text on light** |
| `--jelly-deep` | `oklch(0.52 0.135 52)` burnt amber | `oklch(0.80 0.15 72)` | jelly-colored text and links (contrast-safe) |
| `--glow` | `oklch(0.62 0.11 180)` | `oklch(0.86 0.13 178)` bioluminescent mint | "alive": signals, live state. Use sparingly (≤5% of the page) |
| `--cherry` | `oklch(0.56 0.19 24)` | `oklch(0.70 0.17 24)` | rollback, regressions, errors |
| `--line` | `oklch(0.24 0.03 60 / 0.14)` | `oklch(0.95 0.015 85 / 0.12)` | hairlines |

Gelatin is drawn with layered radial gradients of `--jelly` at 35–85% alpha, plus a hard specular highlight (white at 70–90% alpha, small and offset up-left), plus a soft inner rim (slightly darker at the edge, the way a real jelly cube looks). Run `node ~/Projects/apps/baste/dist/src/cli.js lint-palette` or any WCAG checker on the final values.

## 4. Type

| Role | Family | Why |
|---|---|---|
| Display | **Anybody** (Google Fonts, variable `wdth` 50–150, `wght` 100–900, `ital`) | It squashes and stretches: animate `font-stretch`/`wdth` for jelly type. Headlines settle with a spring on `wdth` (e.g. 135 → 112) |
| Body | **Atkinson Hyperlegible Next** (Google Fonts) | Humanist and very legible: the "exacting lab label" against the squishy display |
| Code / CLI | **Martian Mono** (Google Fonts, variable `wdth`) | Commands like `rad patch`, `sl`, `devenv up`; its width axis can wobble too |

Hero clamp max ≤ 6rem, display letter-spacing ≥ -0.04em, body measure 60–72ch, scale ratio ≥ 1.25. No all-caps sentences. Short lab-label eyebrows are allowed sparingly (e.g. `SPECIMEN 01 · SIGNAL`).

## 5. Motion: the jelly physics

Every motion means something in the product. Never wobble just to decorate.

| Product event | Motion |
|---|---|
| A signal appears | A small mint `--glow` droplet fades in and pulses once (bell rhythm) |
| Dedupe (signals merge) | Gooey metaball merge: droplets touch and fuse (SVG goo filter or shader) |
| A trail starts and moves through states | An amber blob travels along a path, leaving a faint translucent trail; each checkpoint is a bead |
| Proof passes ("it sets") | The jelly's wobble decays to stillness and its highlight sharpens. **"Set"** is our word for proven and landed |
| Rollback | The jelly un-sets: it slumps and drips back, tinted `--cherry` |
| Human checkpoint | A firm press: squash (scaleX 1.06, scaleY 0.92) then spring back |
| Idle logo | Bell pulse: contract 0.35 s, relax 1.1 s, rest 0.6 s. The eight arms trail slightly (secondary motion) |

- **Springs:** use springs, not linear or ease tweens. Default `stiffness 180, damping 14, mass 1` (wobbly, ~10% overshoot). Firm `260 / 22`. Gentle `90 / 12`. Implement a tiny spring solver or use Motion (`motion@11` from jsDelivr) on the site; match the feel in videos.
- **Squash and stretch:** preserve volume (`scaleX * scaleY ≈ 1`).
- **Hover:** cards jiggle once (damped). Buttons squash on press. Display type stretches its `wdth`.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no wobble, no travel. Use 150 ms opacity crossfades, still posters instead of video, and GIFs replaced by their first frame.
- **Performance:** animate only transform/opacity/filter. One WebGL canvas at most, paused offscreen. Never block LCP on video.

## 6. Iconography (Astra)

- A 24 px grid, drawn as **soft solid shapes with a translucent fill and a specular highlight**, not hairline strokes. Picture little gelatin sweets: rounded joins, tiny wobble in contours (never perfectly geometric), consistent light direction (top-left). Each icon must still read at 16 px in one color (`currentColor` variant).
- Two variants per icon: `icon-name.svg` (full-color, uses CSS custom properties `--jelly`, `--glow`, `--cherry` with fallbacks) and `icon-name.mono.svg` (`currentColor` only). Plus an animated variant for the hero set (CSS keyframes inside the SVG, respecting reduced motion).
- **Don't** reproduce any third-party logo (Radicle, Tangled, Sapling, GitHub, Railway, devenv and so on). For "works with" we use **text wordmarks** set in our type, or generic glyphs (a seed, a knot, a stack, a branch).
- Exploration with fal `fal-ai/recraft/v4.1/text-to-vector` is allowed, but final SVGs are hand-cleaned: viewBox `0 0 24 24`, no raster, no embedded fonts, under 2 KB each where possible, ids namespaced.

## 7. Asset manifest (exact paths; the site references these)

All under `site/`. Source files, prompts and raw generations go in `site/_sources/<owner>/`; only shippable files go in `site/assets/`.

| Path | Owner | Spec |
|---|---|---|
| `assets/brand/logo.svg`, `logo.mono.svg`, `logo-animated.svg` | Astra | The ephyra mark: eight arms with notched lappets, translucent bell, small centre manubrium. Readable at 16 px |
| `assets/brand/wordmark.svg`, `lockup.svg` | Astra | "ephyra" in Anybody, outlined to paths (no font dependency) |
| `assets/brand/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180) | Astra | |
| `assets/icons/*.svg`, `assets/icons/sprite.svg` | Astra | Set below |
| `assets/brand/preview.html` | Astra | Contact sheet of marks and icons in both themes, plus the animated ones |
| `assets/img/hero-ephyra.webp` (2400×1350) and `hero-ephyra.png` (transparent cutout) | Opus | GPT Image 2.6 |
| `assets/img/gel-texture-dark.webp`, `gel-texture-light.webp` | Opus | Caustic gelatin textures, tileable |
| `assets/img/specimen-*.webp` | Opus | Section plates (signal, trail, proof, set, rollback, forge) |
| `assets/video/hero-loop.{mp4,webm}` + `hero-loop-poster.webp` | Opus | Seedance 2.5 image-to-video, 5–6 s seamless pulse loop, muted |
| `assets/motion/{logo-pulse,trail-loop,dedupe-merge,inbox-approve,smartlog-stack,set-vs-rollback}.{mp4,webm,gif}` + `-poster.webp` | Astra | HyperFrames. mp4/webm for the site, GIF (≤ 4 MB, ≤ 720 px wide) for README and social |
| `assets/og/og.png` (1200×630) | Astra | Composed from the real type and marks |

**Icon set (24):** signal, trail, evidence, hypothesis, repro, patch, proof, landing, watch, rollback, set (proven), intent, probe, hunter, inbox, checkpoint, human, sandbox, system-one (a tiny decision prism), forge-seed (Radicle-ish, generic), forge-knot (Tangled-ish, generic), git-branch, stack (Sapling-ish, generic), self-host (a house/box).

## 8. Page outline (Fable owns final IA and copy)

1. **Hero.** The specimen ephyra pulsing in amber gelatin (video loop over poster) with an elastic headline. Candidate line: *"Software that sets itself."* Subline: self-driving fixes for production, on forges you own, no pull requests. Primary CTA: read the design. Secondary: `devenv up` copy-chip (marked "soon").
2. **The loop.** Signal → trail → proof → set, as scroll-linked jelly physics (uses `trail-loop`).
3. **Trails, not PRs.** What a trail is. Honest comparison with Murmur, PostHog self-driving and Entire Trails: credit them, no digs.
4. **It hunts.** Active hunting, regressions and intent monitoring (`intents/*.md` snippet).
5. **Cheap judgement.** System One triage, BYOK / hosted / self-hosted (d1, Clef), cost per 10k signals with "illustrative" labelling.
6. **Humans at the checkpoints.** Inbox `a/r/x/t/o` (uses `inbox-approve`), autonomy.md in shadow mode, Sapling smartlog (`smartlog-stack`).
7. **Your forge, your box.** Radicle, Tangled, plain git and Sapling as text wordmarks; Railway or one `devenv up`.
8. **Jellyware.** A short manifesto (credit Amp's term and the episode).
9. **Footer.** Status, links to the design docs, Not Organic, voxq, license (TBD).

Use Framer's landing gallery (https://www.framer.com/community/gallery/categories/landing-page/) for craft benchmarks: section rhythm, CTA clarity, motion polish. Copy its quality bar, not its look.
