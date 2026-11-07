# Jellyware exploration

Thirty generated interface concepts across three generations of ten. Each later generation mutates retained MAP-Elites candidates. The archive keeps the highest weighted assessment per topology/collaboration cell, with earlier concepts winning ties.

`manifest.json` records the prompts, parent IDs, mutations, six criterion scores, and selection rationale. Scores are subjective designer assessments against inferred personas, not measured usability results. Online presence and conversations in generated images are proposed interface concepts.

G3-06 **Connected Notes** was selected for implementation in `site/e/`. Its open document, reviewer annotation, curved connections, and amber action informed the GUI. Actual walkthrough content comes from the CLI sample; interactive discussion and handoff are local browser demos.

Build the browsable comparison from the repository root:

```sh
bun output/jellyware-exploration/build-gallery.mjs
```

Open the generated `gallery.html` to filter generations, inspect the cumulative 3×3 archive, and enlarge any concept. The generator resolves assets relative to the manifest. The 30 WebP delivery images retain the original dimensions at quality 88 and total about 4.6 MiB. Full PNG originals remain locally alongside them and are excluded from git. The standalone generated gallery contains local absolute image paths for embedding and is also excluded from git.
