# @ephyra/web

Ephyra's public site. One Bun handler serves:

- the landing cuts from `site/`;
- the journal: a Standard.site blog on AT Protocol;
- pricing, legal and security pages;
- everything crawlers and LLMs read.

```sh
PORT=3000 EPHYRA_SITE_ORIGIN=https://<origin> bun apps/web/src/main.ts
```

Settings:
- **`EPHYRA_HOME_CUT`:** empty, `b` or `c` picks which landing cut is the home page. Every cut stays reachable at `/a/`, `/b/` and `/c/`.
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
  - that every internal link and `#anchor` on the legal pages, pricing and landing cuts resolves.

## Unverified

- **The legal pages are review copies.** They are not reviewed by a lawyer and not yet effective. A public mailing address and a French edition are still to come.
- **The hosted plan is a proposal.** No billing is implemented.
- **The live publication has not been written yet.** It needs the Ephyra PDS account and the deployed origin.

`design/04-pricing.md` explains the pricing and the Macroscope comparison.
