# @ephyra/web

Ephyra's public site. One Bun handler serves:

- the landing page: cut E ("Immortal", `site/e/`) is the main site, served at `/`; earlier cuts stay at `/a/`, `/b/` and `/c/`, marked noindex and left out of the sitemap;
- the journal: a Standard.site blog on AT Protocol;
- the public guide at `/docs` or on its own host: 23 pages, each also Markdown for agents, with search and an agent brief;
- pricing, legal and security pages;
- everything crawlers and LLMs read.

```sh
PORT=3000 EPHYRA_SITE_ORIGIN=https://<origin> bun apps/web/src/main.ts
```

Settings:
- **`EPHYRA_HOME_CUT`:** `e` (the default), `a`, `b` or `c` picks which cut is served at `/`. The server adds `<base href="/<cut>/">` so the cut's relative links still resolve, and `/<cut>/` redirects to `/`. A cut used as home must not rely on bare `#anchor` links, because they resolve against the base. Cut D is a draft: it isn't committed or copied into the image.
- **`EPHYRA_BLOG_PUBLICATION_URI`:** connects the journal.
- **`EPHYRA_API_ORIGIN`:** links the control plane from `llms.txt`.
- **`EPHYRA_DOCS_ORIGIN`:** a host of its own for the guide. See [the docs host](#the-docs-host).
- **`EPHYRA_SITE_REDIRECT_ORIGINS`:** comma-separated previous origins and aliases that redirect to the canonical site,
  preserving paths and queries. `/healthz` remains available on every host for deployment health checks.

## Routes

| Route | What |
|---|---|
| `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` | Crawl and LLM files, built from the page list and published posts |
| `/blog/`, `/blog/posts/<slug>`, `/blog/feed.xml` | Journal, read from the publication's PDS (`site.standard.publication` / `site.standard.document`) |
| `/.well-known/site.standard.publication` | Publication URI, for verification |
| `/pricing` | Rendered from `src/pricing.ts`; the hosted plan is marked proposed |
| `/docs`, `/docs/<slug>`, `/docs/<slug>.md`, `/docs/agent.md`, `/docs.txt` | The guide, each page as Markdown, the agent brief and the text export. With `EPHYRA_DOCS_ORIGIN` these redirect to the docs host |
| `/legal/`, `/legal/{terms,privacy,acceptable-use,providers}`, `/security` | Bodies in `content/legal/*.html`, operator details from `OPERATOR` in `src/legal.ts` |
| `/.well-known/security.txt` | RFC 9116 contact |
| `/terms`, `/privacy`, trailing slashes | 308 to the canonical path |

Every HTML page gets these at serve time:
- a canonical link and Open Graph and Twitter tags;
- an RSS link;
- JSON-LD.

## Live

Railway service `web` (`infra/docker/Dockerfile.web`, configured in `.railway/railway.ts`) serves https://ephyra.quest.
`ephrya.app`, `www.ephrya.app` and the original `ephyra-site.up.railway.app` redirect to that origin. The application is
https://console.ephyra.quest/app/ on service `server`; its origin is registered in Not Organic's gateway and portal client catalogs.
The older console domain remains attached for existing links. The public site builds the actual React app components
into a separate, explicitly fictional walkthrough at `/e/app/walkthrough.html`; its adapters and CSP prevent live writes.
Read current Railway variables before applying local IaC, which may retain an earlier domain configuration.
The journal is `at://did:plc:soeyznq6axxxa7tarbdxccun/site.standard.publication/self`, on the PDS identity `ephyra.pds.notorganic.info`.
The publication's `url` must equal `EPHYRA_SITE_ORIGIN`, so moving to a custom domain means rewriting the publication record too.
Record-derived `/posts/<slug>` links redirect to `/blog/posts/<slug>`; document record identities and paths stay unchanged.
Deploy with `railway up --service web --ci`.

Porkbun DNS is managed with Sesame. The apex ALIAS points at `018v5dcu.up.railway.app`, `console` CNAME at
`7f8y2trv.up.railway.app`, and `www` CNAME at `xg8sire9.up.railway.app`. Each hostname also has its Railway ownership
TXT record. Read Railway's current domain status before changing these targets or replacing a domain attachment.

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

## Public documentation

The guide is 23 Markdown pages in `content/docs/pages/`, listed in reading order in `DOCS_NAV` (`src/docs.ts`). A page that is not listed there is not published. Each page has front matter (`title`, `summary`) and opens by saying who it is for or what problem it solves; the tests refuse a page that opens on a heading or a table.

Authoring conventions:
- Links between pages are written `./slug` or `./slug#anchor`, so the same source works under `/docs` and on a docs host. Links to the public site use `{{site}}`, `{{app}}` and `{{auth}}`; the control plane is `{{api}}` and the docs themselves `{{docs}}`.
- `> [!TIP]`, `> [!NOTE]` and `> [!WARNING]` become callouts. A code fence tagged `prompt` is a prompt to paste into an agent.
- `<!-- cards -->`, `<!-- steps -->` or `<!-- loop -->` on the line before a list gives it that shape.
- Keep pages aligned with executable contracts. Design proposals are not current capabilities. No account IDs, credentials, incident data or private deployment inventory belong in the public guide.

Every page is served three ways from one source: HTML for people, `/<slug>.md` for agents, and inside `/docs.txt` and `/llms-full.txt`. `/agent.md` is a brief written for coding agents: what Ephyra is, the rules, the setup sequence, and a map of every page as Markdown. Each page offers **Copy page for an agent**, **Copy a prompt**, and links that open Claude or ChatGPT with that prompt.

### The docs host

Set `EPHYRA_DOCS_ORIGIN` (for example `https://docs.ephyra.quest`) and the same process serves the guide at that host's root: `/`, `/<slug>`, `/<slug>.md`, `/agent.md`, `/search.json`, `/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap.xml`. Each page then has one address: `/docs`, `/docs/<slug>` and `/docs.txt` on the public site redirect there (308), and the public site's navigation, sitemap and `llms.txt` name the docs host. Anything else requested from the docs host redirects to the public site. Without the variable the guide is served under `/docs`.

Old single-page links such as `/docs#policy` reach the page that replaced the section: the fragment is handled by `content/docs/client.js` on the overview.

The complete content and anchor navigation work without JavaScript. `content/docs/client.js` progressively adds search over every section of every page (`/search.json`, fetched on first use), `/` to focus it and arrow keys through results, current-section tracking, light/dark/system preferences, and copy actions with an honest fallback when clipboard access is denied. Mobile navigation uses a native disclosure. The stylesheet supports reduced motion, readable code overflow and printing.

`bun test apps/web` checks, with no network: every page on both hosts (canonical URL, one `h1`, no unfilled token); that every link between pages and every anchor resolves; the Markdown, agent brief, text and LLM exports; the search index; docs-host routing and redirects; that the CLI's topic list names exactly the published pages; and that arbitrary queries and paths cannot inject markup.

Checked in a headless browser on 11 November 2026 at 1440×900 (light and dark), 1100×900 and 390×844 (light and dark): no console errors and no horizontal overflow on the overview, CLI, reviewing, troubleshooting and architecture pages; `/` focuses search and "stale decision" returns the troubleshooting section first. `scripts/check-docs.js`, evaluated in a served page, checks the interactions with a stubbed clipboard: it passed on `/docs/cli` (1440×900), `/docs/troubleshooting` (390×844 dark) and, with a docs host configured, on `/policy` (1100×800) and `/` (320×568). Not checked: the copy actions against a real system clipboard, a screen reader, and the docs host behind real DNS.

## Landing walkthrough

Cut E reads `site/e/walkthrough.json`, exported by the CLI from its sample quest. Regenerate it after changing the inbox:

```sh
bun run apps/cli/scripts/walkthrough.ts site/e/walkthrough.json
```

The Graphical / Terminal selector keeps the same quest moment when switching views. Both views use the CLI's exported sample quest, events, hypothesis, plan, and evidence. The GUI embeds the production React `TrailPanel`; its fixture adapter never calls the control plane. The six workspace scenes use the production `App` with fictional local adapters.

The sample label stays visible at every width. Previous/Next buttons and Left/Right, Home/End keys navigate when focus is in the walkthrough. The terminal phone view uses the real 40-column detail layout at a minimum of 13px; short or narrow windows can scroll. Key hints stay outside that window. The full reader opens complete, selectable content in a native dialog with Escape and focus restoration. Short phones use explicit step navigation so the pinned console cannot cover the viewport.

The inline frames are inert previews, so wheel and touch gestures continue down the page. “Explore this screen” and “Read full details” open an interactive, scrollable native dialog. The recorded quest remains read-only. It does not send messages to a server, show live teammates, start/stop agents, or provide authenticated multiplayer. Evidence positioning uses the child window's `scrollTo`; `scrollIntoView` would also move the parent page and desynchronize the story.

Landing HTML, scripts, styles and JSON revalidate between releases. The `20261108-quests` URL suffix evicts the older
five-minute cached walkthrough during this migration; the reader, module imports and fixture share the same suffix.

The visual direction is G3-06, “Connected Notes”: open reading surfaces, curved connections, restrained membrane edges, and amber checkpoint actions. `output/jellyware-exploration/` contains the 30-concept, three-generation MAP-Elites comparison, prompts, lineage, and subjective assessment scores. The generated concept images include proposed collaboration behavior; the walkthrough uses only the recorded fixture and the local demo described above.

`apps/console/scripts/landing-scroll.probe.js` runs in the shared browser. It checks all nine scenes forward and backward, page drift, alignment, preview gesture handling, arrow navigation and details-dialog position restoration. `apps/console/scripts/product-walkthrough.ts` covers the six workspace scenes, nine recorded moments and frame-origin boundary. Older `apps/web/scripts/check-console.js` checks the retired hand-built GUI and does not validate the React walkthrough. These checks use sample data; they are not evidence of real production repairs, forge landing, or networked collaboration.

Cut D remains an untracked draft; the landing walkthrough and its checks do not depend on it. A local server without `EPHYRA_BLOG_PUBLICATION_URI` cannot serve the design article; the walkthrough link works without a connected publication.

## Opening the application

Cut E and the shared navigation link **Open app** to `/app/`. Set `EPHYRA_API_ORIGIN` to the control-plane server origin; the public site redirects there without forwarding user-supplied destinations. The server image includes the console and offers browser sign-in when Not Organic is configured. The sample quest remains explicitly a demonstration. Without an API origin, `/app/` reports that the deployment is not connected.
