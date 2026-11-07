# @ephyra/web

Ephyra's public site. One Bun handler serves:

- the landing page: cut E ("Immortal", `site/e/`) is the main site, served at `/`; earlier cuts stay at `/a/`, `/b/` and `/c/`, marked noindex and left out of the sitemap;
- the journal: a Standard.site blog on AT Protocol;
- pricing, legal and security pages;
- everything crawlers and LLMs read.

```sh
PORT=3000 EPHYRA_SITE_ORIGIN=https://<origin> bun apps/web/src/main.ts
```

Settings:
- **`EPHYRA_HOME_CUT`:** `e` (the default), `a`, `b` or `c` picks which cut is served at `/`. The server adds `<base href="/<cut>/">` so the cut's relative links still resolve, and `/<cut>/` redirects to `/`. A cut used as home must not rely on bare `#anchor` links, because they resolve against the base. Cut D is a draft: it isn't committed or copied into the image.
- **`EPHYRA_BLOG_PUBLICATION_URI`:** connects the journal.
- **`EPHYRA_API_ORIGIN`:** links the control plane from `llms.txt`.

## Routes

| Route | What |
|---|---|
| `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` | Crawl and LLM files, built from the page list and published posts |
| `/blog/`, `/blog/posts/<slug>`, `/blog/feed.xml` | Journal, read from the publication's PDS (`site.standard.publication` / `site.standard.document`) |
| `/.well-known/site.standard.publication` | Publication URI, for verification |
| `/pricing` | Rendered from `src/pricing.ts`; the hosted plan is marked proposed |
| `/legal/`, `/legal/{terms,privacy,acceptable-use,providers}`, `/security` | Bodies in `content/legal/*.html`, operator details from `OPERATOR` in `src/legal.ts` |
| `/.well-known/security.txt` | RFC 9116 contact |
| `/terms`, `/privacy`, trailing slashes | 308 to the canonical path |

Every HTML page gets these at serve time:
- a canonical link and Open Graph and Twitter tags;
- an RSS link;
- JSON-LD.

## Live

Railway service `web` (`infra/docker/Dockerfile.web`, configured in `.railway/railway.ts`) serves https://ephyra-site.up.railway.app.
The journal is `at://did:plc:soeyznq6axxxa7tarbdxccun/site.standard.publication/self`, on the PDS identity `ephyra.pds.notorganic.info`.
The publication's `url` must equal `EPHYRA_SITE_ORIGIN`, so moving to a custom domain means rewriting the publication record too.
Deploy with `railway up --service web --ci`.

## Publishing the journal

```sh
EPHYRA_BLOG_PUBLICATION_URI=at://did:plc:…/site.standard.publication/self EPHYRA_BLOG_ORIGIN=https://<origin> \
  bun apps/web/src/publish.ts --input=apps/web/content/articles.json            # dry run
EPHYRA_BLOG_APP_PASSWORD="$(skate get ephyra-blog-app-password@secrets)" … --write   # compare-and-swap, then read back
```

## Verified

- `bun test apps/web` runs everything against a fake PLC and PDS; it makes no network calls. It checks:
  - the SEO files, and that they keep serving when the PDS is down;
  - the publisher's validation, compare-and-swap and read-back;
  - every legal page: its canonical link, its review notice, and that no placeholders are left;
  - the redirects and `security.txt`;
  - that the pricing page matches `pricing`;
  - that every internal link and `#anchor` on the legal pages, pricing and landing cuts resolves;
  - that every relative URL on the home page, including the sprites `site/e/main.js` loads, resolves through `<base>`.

## Unverified

- **The legal pages are review copies.** They are not reviewed by a lawyer and not yet effective. A public mailing address and a French edition are still to come.
- **The hosted plan is a proposal.** No billing is implemented.

`design/04-pricing.md` explains the pricing and the Macroscope comparison.

## Look

The journal, pricing, legal and security pages share cut E's tokens and type (Anybody, Atkinson Hyperlegible Next): water at the top of the page where production is, the seabed under the footer. The share card `site/assets/og/og.png` is rendered from `site/_sources/og/og.html` (gitignored with the other sources).

## Landing walkthrough

Cut E reads `site/e/walkthrough.json`, exported by the CLI from its sample trail. Regenerate it after changing the inbox:

```sh
bun run apps/cli/scripts/walkthrough.ts site/e/walkthrough.json
```

The Graphical / Terminal selector keeps the same trail moment when switching views. “Born for the terminal?” opens the TUI. Both views use the CLI's exported sample trail, events, hypothesis, plan, and evidence. The GUI offers Review, Evidence, Files, Activity, and Discuss; unavailable documents and source diffs are explicitly identified. Checkpoint buttons advance the sample and never call the control plane.

The sample label stays visible at every width. Previous/Next buttons and Left/Right, Home/End keys navigate when focus is in the walkthrough. The terminal phone view uses the real 40-column detail layout at a minimum of 13px; short or narrow windows can scroll. Key hints stay outside that window. The full reader opens complete, selectable content in a native dialog with Escape and focus restoration. Short phones use explicit step navigation so the pinned console cannot cover the viewport.

Discuss combines the recorded reviewer comment with local notes and takeover/return controls. Notes and control changes synchronize between tabs at the same origin through browser storage and BroadcastChannel. Drafts stay scoped to their trail; incoming changes preserve the input node, focus, and caret. This is labeled a local demo: it does not send messages to a server, show live teammates, start/stop agents, or provide authenticated multiplayer. Storage failure falls back to memory with an explicit notice.

The visual direction is G3-06, “Connected Notes”: open reading surfaces, curved connections, restrained membrane edges, and amber checkpoint actions. `output/jellyware-exploration/` contains the 30-concept, three-generation MAP-Elites comparison, prompts, lineage, and subjective assessment scores. The generated concept images include proposed collaboration behavior; the walkthrough uses only the recorded fixture and the local demo described above.

`apps/web/scripts/check-tour.js` checks every terminal step, keyboard boundaries, sample labels, the complete reader output against the exported fixture, and checkpoint C's highlighted approval key. `check-console.js` checks all nine GUI moments and five tools, view switching, actions, full reader, focus restoration, and overflow. Evaluate these scripts in the served home page after the walkthrough loads. GUI checks passed at 1440×900 and 390×844 in both themes, and 320×568 dark; the TUI checks passed at desktop, phone, and short-phone sizes. A separate two-tab browser exercise verified note/control synchronization and draft/caret preservation. These are local UI checks with sample data, not evidence of real production repairs, forge landing, or networked collaboration.

The repository test for `/d/` currently expects an untracked draft that is absent in clean worktrees. The landing walkthrough does not depend on it. A local server without `EPHYRA_BLOG_PUBLICATION_URI` cannot serve the design article; the walkthrough link works without a connected publication.
