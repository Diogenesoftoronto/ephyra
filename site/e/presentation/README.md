# Ephyra presentation

An interactive presentation for potential users and collaborators, grounded in the current implementation and product intent.
Twelve chapters cover quests, autonomy, the actual UI, onboarding, agent sessions and visuals, Viewer/Approver invitations,
intent and knowledge, persona materials and motion, durable ownership, and the next real-repair acceptance milestone.

Open `index.html` through the site at `/e/presentation/`, or produce the standalone offline HTML:

```sh
rtk proxy python3 site/e/presentation/build.py
```

The export goes to `output/ephyra-presentation.html`. It embeds its fonts, images, six finite character greetings,
and three sound previews. No media generation, account action, invitation, or provider job runs from this presentation.
The final QR shares the public presentation, not a workspace invitation.

## Controls

Previous/Next or Left/Right move between chapters; Home/End jump to the beginning/end. N toggles presenter notes.
Arrow keys inside an explorable group change its selection without changing chapters. Chapters opens a native dialog.
Screens enlarge in a separate native dialog with Escape and focus restoration. No scroll or wheel interception.
Media is user-initiated, finite, and stopped when leaving its chapter or hiding the tab. Reduced motion keeps stills.
The default HTML retains all chapters if JavaScript is unavailable.

## Sources and boundaries

`provenance.json` records captures from the actual deployed walkthrough and the source files for reused brand/media assets.
Screens use explicitly fictional sample data. Sample proof and counts are not a production repair or measured product outcome.
Notes cite the current README, console documentation, setup/knowledge design and persona/media manifests.
The original supervised design is not presented as the current default. Live account/provider/forge success and a full
autonomous production repair remain separate acceptance evidence.

Fonts are the existing Anybody and Atkinson Hyperlegible Next families, self-hosted with their OFL licenses in `media/`.
Agent logos retain the sources and licensing in `apps/console/public/engines/README.md`; the Codex mark uses the included
Lobe Icons MIT license. Third-party marks identify harnesses and do not imply endorsement.

Verification covers chapter navigation, group-key handling, focus restoration, media stop/fallback behavior, and measured
layout through T3 HTML previews. Physical phones, Safari decoding, and human listening quality are not established here.

`verification.json` records 74 passing interaction/layout checks at 320, 390, 728 and 1200px, plus 75 with a simulated
reduced-motion preference. All six selected videos and three cues decoded in the HTML preview browser. The sharing QR
decoded from rendered pixels to the exact public presentation URL. The full workspace typecheck and 1,039 tests passed.
