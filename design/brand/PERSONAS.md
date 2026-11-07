# Ephyra personas (v0, 2026-11-07)

Six agent personas for the web console. A persona is a role in the loop, not a model (see `packages/core/src/console.ts` and `design/05-console.md`). The names are parts of the immortal jellyfish on the home page (cut E), and the avatars are **laboratory gelatin specimens** from that same world: translucent gel on a lightbox, lit from behind, exacting and a little squishy. No faces, no eyes, no limbs, no mascots.

Assets live in `apps/console/public/personas/` and are served from `/app/personas/`. `manifest.json` there lists every file with size and dimensions; `sheet.webp` is the review contact sheet.

| Persona | Role | Namesake | Motif | Token |
|---|---|---|---|---|
| **Rho** | Listener (extract, triage) | rhopalium, the sense organ | a mint pod on a stalk with a glowing bead inside | `--persona-rho` |
| **Bell** | Researcher (research, evidence) | the bell, the body that carries everything | the amber gummy bell with four stubby tentacles | `--persona-bell` |
| **Nema** | Prover (repro, proof) | nematocyst, the cell that stings to test | a pink capsule with a coiled thread and a barb | `--persona-nema` |
| **Lappet** | Mender (plan, patch, review) | lappet, the soft flap at the bell's edge | two green petals laid over each other like a patch | `--persona-lappet` |
| **Turri** | Watcher (land, watch, rollback) | *Turritopsis*, which turns back time | a cherry sphere with a curling tail, a comma that undoes | `--persona-turri` |
| **Velum** | Scribe (draft) | velum, the membrane that shapes the flow | a pale blue membrane disc with a soft central opening | `--persona-velum` |

## Shared rules

- **One material.** Clear gelatin, glossy, lit from behind, one specular highlight, faint internal veining. Each persona is a different *shape and tint* of the same stuff. Never a different medium (no metal, no plastic, no fur, no paper).
- **Silhouette first.** Every avatar must be identifiable from its filled silhouette at 24–32 px. The SVG marks are exactly those silhouettes, flat, with one white highlight and one white inner detail. No hairlines, no outlines.
- **Colour is secondary identity.** One tint per persona. The tints below pass 4.2:1 or better as graphics against the cut E light background (`oklch(0.975 0.012 85)`) and 9:1 or better against the dark one (`oklch(0.165 0.022 250)`). Use the token for rings, dots, and name labels. Don't use the persona tints for body text on light.
- **Motion is breath, not gesture.** Idle loops are slow (one cycle in 3–4 s), small (gel wobble, a tilt, a glow), and seamless. No hopping, no eyes blinking, no waving. "Working" loops are the same motion faster and brighter, never a new motion.
- **Voice is plain and calm.** Short sentences, present tense, no exclamation marks, no emoji, no "I'm excited". They say what they did, what they found, and what they need. Rho, Bell, Nema, Lappet and Turri **report**: they speak in the activity feed and on trail timelines. Velum **converses**: it is the one you chat with in the Workspace.
- **They never pretend.** A persona says "unverified" or "I couldn't" rather than inventing a result. This is the brand rule (never synthesize evidence) made audible.

## Colour tokens

Both values are in sRGB gamut. Contrast ratios are WCAG luminance contrast against the cut E page backgrounds.

```css
:root {
  --persona-rho:    oklch(0.55 0.10 180);  /* #008474  4.3:1 on light */
  --persona-bell:   oklch(0.56 0.13 60);   /* #aa5f04  4.5:1 */
  --persona-nema:   oklch(0.56 0.20 355);  /* #c62b7a  4.8:1 */
  --persona-lappet: oklch(0.55 0.15 135);  /* #478416  4.3:1 */
  --persona-turri:  oklch(0.56 0.19 24);   /* #cc3239  4.8:1, the brand cherry */
  --persona-velum:  oklch(0.55 0.09 230);  /* #2e7b9c  4.4:1 */
}
:root[data-theme="dark"], @media (prefers-color-scheme: dark) :root:not([data-theme="light"]) {
  --persona-rho:    oklch(0.86 0.13 178);  /* #5dedd1  13.3:1 on dark, the brand glow */
  --persona-bell:   oklch(0.80 0.15 72);   /* #f8ac3d  10.1:1, the brand jelly-deep */
  --persona-nema:   oklch(0.80 0.12 350);  /* #f89dc9   9.8:1 */
  --persona-lappet: oklch(0.84 0.17 130);  /* #a5e060  12.3:1 */
  --persona-turri:  oklch(0.72 0.17 24);   /* #fd736f   7.2:1, the brand cherry */
  --persona-velum:  oklch(0.82 0.08 225);  /* #8ad0eb  11.3:1 */
}
```

The SVG marks carry both values internally (a `prefers-color-scheme` media query inside the file), so they theme themselves when used as `<img>` or as a favicon.

---

## Rho, the Listener

**Motif.** A rhopalium: a single club-shaped pod of pale mint gel, a short thick stalk widening into a rounded bulb, tilted a few degrees like an antenna cocked toward a sound. One bright bead (the statolith) sits inside the bulb.

**Silhouette rule.** A circle on a stem, the stem shorter than the bulb's diameter, the bulb offset to the upper right. If it reads as a lollipop or a spoon it is too symmetrical; if the stalk is longer than the bulb it reads as a balloon. The bead is the only interior detail.

**Colour.** Light `oklch(0.55 0.10 180)`, dark `oklch(0.86 0.13 178)`. Mint is the brand's "alive" colour; Rho is the one that hears signals, so it is the only persona allowed to own it.

**Voice (reports).**
- "Three new errors in checkout since 09:10. Two are the same stack. One trail opened."
- "This looks like the trail you closed on Tuesday. Merged it as a duplicate."
- "Not enough to act on yet. Watching for a second occurrence."

**Idle loop.** The pod sways slowly on its stalk, a few degrees left and right, the gel lagging a little behind the tilt. The bead glows up and down once per cycle.

**Working loop.** The sway stops and the pod leans in and holds; the bead pulses faster and brighter, twice per second, like a level meter catching a signal.

**Do.** Keep the bead small and bright. Let it lean. Use mint only for Rho and for live state.
**Don't.** Add a second bead, an ear, a dish, or sound waves. Don't make it stand straight up.

## Bell, the Researcher

**Motif.** The medusa itself, simplified to a gummy: a smooth amber dome with a scalloped rim, four short, thick, rounded tentacles, and the faint four-leaf clover of the stomach pouches inside. Bell is the anchor of the set; the other five were generated from it.

**Silhouette rule.** A dome wider than it is tall, flat-bottomed, with exactly four stubby legs no longer than half the dome's height. More legs or longer legs and it becomes a generic jellyfish; fewer and it becomes a mushroom.

**Colour.** Light `oklch(0.56 0.13 60)`, dark `oklch(0.80 0.15 72)`. Bell is the brand's honey amber, the body everything else hangs from.

**Voice (reports).**
- "Found the commit that introduced the null path: 3f9a2c, nine days ago, in the retry helper."
- "Two earlier trails touched this file. Neither reached proof. Linked both."
- "Hypothesis for checkpoint A: the cache key drops the region. Evidence attached."

**Idle loop.** The bell breathes: a slow contraction and release, tentacles swaying a beat behind, the clover brightening as it contracts.

**Working loop.** The same breath at twice the tempo, the clover glowing steadily rather than pulsing, as if it is holding its breath while it reads.

**Do.** Keep the clover soft and interior. Keep the rim scallops shallow.
**Don't.** Give it long trailing tentacles, a face, or a glow halo outside the body.

## Nema, the Prover

**Motif.** A nematocyst: an upright oval capsule of eosin-pink gel with a tightly coiled pale thread inside and a short barbed tip just emerging from the lid. It is the cell that stings to test.

**Silhouette rule.** A tall capsule, about twice as tall as wide, tilted slightly, with one small spike at the top and a visible zigzag inside. The spike must be short (under a fifth of the height) or it reads as a weapon; the coil must be visible at 32 px or it reads as a pill.

**Colour.** Light `oklch(0.56 0.20 355)`, dark `oklch(0.80 0.12 350)`. Eosin pink is a lab stain, and the colour of a sting mark. It is deliberately not the cherry (that is undo, Turri's).

**Voice (reports).**
- "Reproduction written. It fails the way the signal does: timeout on the second retry."
- "Proof run: 412 tests, 412 pass, the new one included. Sandbox log attached."
- "Could not run the proof. The sandbox had no network for the fixture. Marked unverified."

**Idle loop.** The capsule rests and breathes; the coil inside slowly tightens and relaxes, the capsule swelling a hair; the barb twitches once per cycle.

**Working loop.** The coil winds visibly tighter and faster, the glow concentrates at the lid, and the barb extends a little further, held, until the loop resets.

**Do.** Keep the coil regular and the capsule smooth. Let the barb be small.
**Don't.** Show it firing. No splash, no spark, no target, no syringe.

## Lappet, the Mender

**Motif.** Two thick petal-shaped lobes of fresh leaf-green gel, the upper laid diagonally over the lower, overlapping by a third: a soft patch laid over a seam. Lappets are the flaps at the bell's margin, and this is the one that covers the hole.

**Silhouette rule.** Two rounded lobes of equal size, clearly overlapping, the pair leaning up and to the right. If the lobes don't overlap it reads as a bow tie; if they overlap fully it reads as a blob. Scalloped outer edges are optional and must be shallow.

**Colour.** Light `oklch(0.55 0.15 135)`, dark `oklch(0.84 0.17 130)`. New-growth green: the polyp budding again.

**Voice (reports).**
- "Plan: one change in the retry helper, no new dependency. Three files touched."
- "Patch ready for checkpoint B. Diff is 24 lines. The repro passes locally."
- "Reviewed my own patch against the hypothesis. One edge case I couldn't cover; noted it."

**Idle loop.** The upper petal lifts a few millimetres and settles back down over the lower one, like a flap smoothing itself; the gel wobbles and the glow brightens as it settles.

**Working loop.** The petals slide a little against each other in a steady rhythm, as if pressing the patch flat, with the overlap region glowing.

**Do.** Keep both lobes thick and glossy. Keep the overlap obvious.
**Don't.** Add veins, a stem, a needle, thread, or a bandage cross. Not a leaf, not a plaster.

## Turri, the Watcher

**Motif.** A *Turritopsis* cyst: a smooth sphere of cherry gel with a thick tail curling up and around behind it, tapering to a soft tip, like a comma or an undo arrow. Inside the sphere a faint tiny jellyfish bud waits to grow again.

**Silhouette rule.** A circle with one curved tail rising from its upper right and sweeping back over it, the tail about as long as the circle's diameter. The tail has to curl *back* (counter-clockwise from the sphere) or it reads as a tadpole or a balloon string. The bud is the only interior detail.

**Colour.** Light `oklch(0.56 0.19 24)`, dark `oklch(0.72 0.17 24)`. This is the brand cherry, the colour of rollback, and only Turri owns it.

**Voice (reports).**
- "Landed to main at 14:02. Watching production for the next six hours."
- "The error is back, twice in ten minutes. Rolling back now."
- "Quiet for six hours. Trail set."

**Idle loop.** The sphere rolls in place a few degrees and back while the tail sweeps slowly behind it like a clock hand turning backwards; the bud drifts inside.

**Working loop.** During a rollback the tail sweeps a full arc in reverse and the sphere pulses cherry-bright once per sweep. During a quiet watch, the idle loop runs at half speed.

**Do.** Keep the tail thick and the curl obvious. Keep the bud faint.
**Don't.** Draw a clock face, an arrow head, an eye, or a target reticle.

## Velum, the Scribe

**Motif.** The velum: a thin, round membrane of pale sea-glass blue gel seen at a three-quarter angle, like a shallow dish or a soft lens. A smooth rim, concentric ripples flowing inward, and a small soft opening at the centre. It is the membrane that shapes the current, and the one you talk to.

**Silhouette rule.** A wide ellipse with one small hole near its centre and nothing else. Hole diameter under a quarter of the disc. If the hole is big it becomes a doughnut or a lifebuoy; if the disc is a perfect circle face-on it becomes a record. The ripples are interior detail and can disappear at 32 px.

**Colour.** Light `oklch(0.55 0.09 230)`, dark `oklch(0.82 0.08 225)`. The low-chroma blue of the home page's water, not a SaaS blue. It is the coolest and most transparent persona, because it is the one that stays out of the way.

**Voice (converses).**
- "I can make checkpoint C blocking for anything under `billing/`. Here is the diff. Want it to apply to `payments/` too?"
- "That threshold would route about a third of last week's signals to a human. Is that the level you want?"
- "I don't know what `risk: amber` should mean in this document yet. Tell me and I'll draft it."

**Idle loop.** Slow concentric ripples flow from the rim to the opening, which widens and narrows a little like a breath; the disc tilts a few degrees and back.

**Working loop (`velum-typing.gif`).** Brisk ripples pulse inward in short bursts, three pulses then a rest, the opening flexing and the glow brightening on each pulse. This plays while Velum is composing a reply.

**Do.** Keep it thin and pale. Let it be the quietest shape on screen. Ask before changing a document.
**Don't.** Give it a speech bubble, a pen, a cursor, text, or a mouth. Never let the opening look like an eye.

---

## Files

Per persona, in `apps/console/public/personas/`:

| File | What | Notes |
|---|---|---|
| `<id>.webp` | 512×512 still, transparent | GPT Image 2.6 output, lossy WebP with alpha |
| `<id>-64.webp` | 64×64 still, transparent | same source |
| `<id>.svg` | 32×32 flat mark | hand-drawn, self-theming via `prefers-color-scheme` |
| `<id>.webm` | 512×512 idle loop, 3.75 s, VP9 | **opaque** on the cut E dark background `#070f18` |
| `<id>.mp4` | 512×512 idle loop, 3.75 s, H.264 | same, for Safari |
| `<id>.gif` | 256×256 idle loop, 10 fps, 64 colours | all under 600 KB (`velum-typing.gif` uses 48 colours to fit) |

Plus `velum-typing.gif` (and `.webm`/`.mp4`), `sheet.webp` and `manifest.json`.

**What isn't there, and why.** There is no alpha WebM. Seedance 2.5 renders onto an opaque background, so the loops were generated on the cut E dark page colour and shipped that way. Keying a translucent, glowing object off a flat background loses the glow and fringes the edges, so I did not fake it. If the console shows loops on a light surface it should either put them in a dark gel "specimen well" or use the transparent still plus a CSS breathing transform (scale 1 → 1.03 → 1 over 3.5 s, which is a decent stand-in for every idle loop here). The loops are made seamless by ping-pong (forward 1.9 s, then the same frames reversed), which suits breathing and wobbling but means nothing in a loop can rotate continuously.

## How they were made

Scripts and raw outputs are in `site/_sources/personas/` (gitignored): `gen.py` submits fal queue jobs from `prompts/*.json`, `work/svg.py` writes the marks, `work/colors.py` derives the hex values and contrast ratios, and `work/loop.sh` turns a Seedance clip into the webm/mp4/gif set.

### Stills: GPT Image 2.6 on fal

Bell was generated first with `openai/gpt-image-2.6/flare/text-to-image` (1024×1024, quality high, `background: transparent`, two candidates). The other five were generated with `openai/gpt-image-2.6/flare/edit`, passing Bell as the reference image so the set stays consistent. Lappet and Velum were regenerated once each: the first Lappet read as sea lettuce and the first Velum as a doughnut.

Shared style text (prepended to the Bell prompt):

> Macro photograph of one small laboratory specimen made of clear gelatin, photographed on a white lightbox, lit from behind so the gel glows from inside. The material is translucent, glossy and slightly wobbly, like honey jelly or a gummy, with faint soft internal veining and one clean specular highlight on top. Precise, calm, scientific product-photography framing; soft edible squish. Isolated, centered, filling about 70% of the square frame, no shadow except a tiny soft contact shadow, transparent background. No face, no eyes, no mouth, no limbs, no text, no label, no cartoon outline, not a mascot.

Bell (text-to-image), after the style text:

> The specimen: a small jellyfish bell, a smooth rounded dome of honey-amber gelatin (warm amber, colour #ec9402 glowing from within, paler toward the rim), seen slightly from the side and a little from below so the dome is the whole silhouette. The rim is gently scalloped into eight soft lobes and from it hang four short, thick, rounded stubby tentacles of the same amber gel, no longer than half the dome height. Inside the dome a faint four-leaf clover of slightly deeper amber (the stomach pouches). It looks like a single translucent amber gummy bell.

Edit prompt frame used for the other five (with Bell as `image_urls[0]`):

> The reference image is one specimen from a set of six laboratory gelatin specimens. Create a DIFFERENT specimen from the same set, matching the reference exactly in material, lighting, camera, scale and rendering: clear glossy gelatin photographed on a white lightbox, lit from behind so it glows from inside, faint soft internal veining, one clean specular highlight, tiny soft contact shadow, isolated and centered filling about 70% of a square frame, transparent background. No face, no eyes, no mouth, no text, no cartoon outline, not a mascot. The new specimen: …

The six specimen descriptions that shipped:

- **Rho:** a rhopalium, a jellyfish sense organ, as a single club-shaped pod: a short thick stalk at the bottom widening into a smooth rounded teardrop bulb at the top, the whole thing standing upright and tilted slightly to the right like a tiny listening antenna. The gel is pale mint-green (#5dedd1 glow, paler and more transparent than the amber reference) and inside the bulb sits one small bright crystal bead (a statolith) glowing white-mint. Simple, one bulb, one stalk.
- **Nema:** a nematocyst, the stinging capsule: a smooth upright oval capsule of translucent eosin-pink gelatin (#f06a9a, glowing from inside) with a tightly coiled pale thread visible inside it like a spring, and at the top a short barbed tip just beginning to pop out of the capsule lid. One capsule, upright, slightly tilted, simple and clean.
- **Lappet (second take):** a lappet, the soft flap at a jellyfish bell edge: exactly two thick, smooth, rounded petal-shaped lobes of fresh leaf-green gelatin (#8fd68a, glowing from inside), the upper petal laid diagonally over the lower petal so they overlap by a third, like a soft patch laid over a seam. Each petal has one gently scalloped outer edge and a clean smooth surface. Thick glossy gummy petals, not leaves, no veins, no stem. Two lobes only, simple, clean silhouette.
- **Turri:** a Turritopsis cyst, the stage where the jellyfish turns back time: a smooth sphere of translucent cherry-red gelatin (#fd736f, glowing from inside) with a single thick curling tail of the same gel sweeping around and behind it like a comma or an undo arrow, the tail tapering to a soft rounded tip. Inside the sphere a faint tiny jellyfish bud. One sphere, one curling tail, simple.
- **Velum (second take):** a velum, the thin membrane inside a jellyfish bell rim: a soft round gelatin membrane seen at a three-quarter angle, like a shallow translucent dish or a soft lens, pale sea-glass blue (#a9d3e6, glowing from inside, more transparent than the amber reference). Its rim is a smooth thin rounded ring and the membrane inside dips to a small soft central opening, with fine concentric ripples flowing toward it like water shaping a current. Thin and veil-like, not a doughnut, not a thick ring. One membrane, simple, clean silhouette.

Rejected takes: Lappet v1 ("two overlapping soft rounded lobes … like two thick petals or a folded patch, edges gently scalloped and slightly curling") and Velum v1 ("round translucent disc … with a soft round opening in the centre, like a gel iris or a soft lens diaphragm, the rim thick and smooth").

### Marks: hand-drawn SVG

I did not use `fal-ai/recraft/v4.1/text-to-vector`. The marks are six small geometric paths written by hand from the silhouette rules above (`work/svg.py`), which came out cleaner than a traced vector would and cost nothing. Each is a 32×32 viewBox, body colour plus one white highlight at 45% and one white interior detail.

### Loops: Seedance 2.5 on fal

Each still was composited onto `#070f18` and sent to `bytedance/seedance-2.5/us/image-to-video` at 480p, 4 s, no audio, H.264 (the output is 640×640 at 24 fps). Prompt frame:

> Product-photography loop of the translucent gelatin specimen. Camera locked, framing identical to the first frame, plain dark background stays perfectly still and uniform, the specimen stays in place and keeps its exact colour and shape. *(motion)* Calm, subtle, seamless, nothing enters the frame, no cuts, no text.

Motions:

- **Bell:** The bell breathes very slowly: it contracts a little and relaxes, the gel wobbles softly like jelly, the four stubby tentacles sway gently, the inner glow brightens slightly as it contracts.
- **Rho:** The mint gel pod sways very slowly on its stalk, leaning a little left then right like it is listening, the gel wobbling softly; the small crystal bead inside pulses with a slow gentle glow.
- **Nema:** The pink gel capsule rests and breathes: the coiled thread inside slowly tightens and relaxes like a spring winding, the capsule swells very slightly, and the barbed tip at the top twitches once, gently.
- **Lappet:** The two green gel petals breathe softly: the upper petal lifts a few millimetres and settles back over the lower one, like a flap smoothing itself down, the gel wobbling gently and the inner glow brightening slightly as it settles.
- **Turri:** The cherry gel sphere rolls in place a few degrees and back while the curling tail sweeps slowly behind it like a clock hand turning backwards; the tiny jellyfish bud inside drifts gently; soft gel wobble.
- **Velum (idle):** The pale blue gel membrane ripples very slowly: fine concentric waves flow from the rim toward the central opening, which widens and narrows slightly like a slow breath; the whole disc tilts a few degrees and back.
- **Velum (typing, second take):** The membrane is busy writing a reply: clearly visible concentric ripples pulse quickly from the rim into the central opening, three brisk pulses then a short rest, repeated; with each pulse the central opening squeezes shut and springs open again and the gel glows noticeably brighter, then dims in the rest. The whole disc bobs slightly up and down with the rhythm. Lively but still calm.

The first typing take ("quick, small concentric ripples … like someone typing a reply") was too close to the idle loop to tell apart, so it was regenerated with the stronger description above. The shipped take has one bright pulse per direction of the ping-pong (two per 3.75 s loop) and a small bob; it is the most "busy" of the set while still being gel.

Post-processing (`work/loop.sh`): crop square, scale to 512, take the first 1.9 s, append the same frames reversed (dropping the turning frames), encode H.264 CRF 22, VP9 CRF 34, and a 256 px GIF at 10 fps with a 64-colour per-file palette, a 0.8 px blur before quantizing, and ordered dither. Seedance drifts colour slightly over 4 s (the bell gets a shade darker and more saturated), which is why the loops use only the first 1.9 s.

## Spend

fal bills GPT Image 2.6 per token and Seedance per second of output, and does not return a price per call, so these are computed from the published rates on 2026-11-07 (image output tokens $30 per million, image input $8 per million; Seedance 480p $0.2205 per second). fal's billing page is the record.

| Call | Model | Est. cost |
|---|---|---|
| bell (2 images, 1024², high) | gpt-image-2.6 flare text-to-image | $0.25 |
| rho, nema, lappet, turri, velum (1 image each, Bell as reference) | gpt-image-2.6 flare edit | $0.70 |
| lappet2, velum2 (regenerations) | gpt-image-2.6 flare edit | $0.28 |
| bell-idle, rho-idle, nema-idle, lappet-idle, turri-idle, velum-idle (4.04 s each, 480p) | seedance-2.5 image-to-video | $5.35 |
| velum-typing, velum-typing2 (4.04 s each, 480p) | seedance-2.5 image-to-video | $1.78 |
| **Total** | | **≈ $8.40** |

No Recraft calls. Nothing failed; every fal call returned media on the first try.

## What I'd improve

- **Alpha loops.** Render the idle motion as a CSS or canvas animation over the transparent still (breathing scale, a slow tilt, a glow blend) so it works on any surface, and keep the video loops for the Personas page and marketing.
- **Velum's hole.** Even in the second take it is a touch doughnut-like at 512 px. A third pass with the membrane more dish-shaped and the opening smaller would help.
- **Rho's stalk.** It reads well, but a slightly longer, thinner stalk would separate it further from Turri's sphere at 24 px.
- **Continuous motion.** Ping-pong means Turri's tail cannot sweep a full circle. A 1080p, 8 s clip with the motion prompted as a true cycle, then matched by crossfade, would allow it, at roughly four times the cost per loop.
- **Light-mode loop variants.** If the console ends up light by default, regenerate the seven loops on `#faf6ee` (about $6 more).
