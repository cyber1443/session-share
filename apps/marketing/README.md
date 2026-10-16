# Claude Share marketing website

Live: https://claudeshare.space

Standalone, dependency-free marketing website. The application board remains in `apps/web`.

## Preview

From the repository root:

```sh
python3 -m http.server 4173 --directory apps/marketing
```

Open http://localhost:4173. No build or install step is needed.

## Legacy Vercel preview

Production deploys through Coolify as described below. To update the legacy
Vercel preview, run from `apps/marketing` with an authenticated Vercel CLI:

```sh
vercel link --project session-share
vercel --prod
```

The Vercel project uses this directory as the deployment source. Its configuration explicitly disables framework detection, installation, and building. Do not deploy the repository root as the marketing site.

## Content and interactions

- One-minute video walkthrough with native playback controls, inline mobile playback, a poster, and an accessible text walkthrough. Video loads only when requested (`preload="none"`).
- Claude Code and GitHub reflect the existing product workflow.
- Jira, Slack, and Linear are explicitly labeled **In development**. Roadmap dialogs describe planned functionality only.
- Copyable install commands, mobile navigation, accessible native FAQ and integration dialogs.
- Self-hosted fonts with OFL licenses, favicon, social preview, reduced-motion support, and security headers.

Product claims and installation instructions are based on the repository README. Keep the roadmap status synchronized with actual releases.

## Public discovery (Claude Share)

The canonical production site is https://claudeshare.space, served by the sibling
`session-share-cloud` Coolify deployment. Pin this repository's new commit in
that deployment's Dockerfile to publish marketing changes. The older Vercel
address is a legacy preview, not the canonical production address.

- Public, indexable pages: `/` and `/guide/`; both are present in `sitemap.xml`.
- Metadata and JSON-LD describe the actual product. FAQ structured data must
  match the visible answers; never add fabricated reviews or ratings.
- `/llms.txt` is a supplemental product reference, not a requirement or promise
  of inclusion in any AI service. The same facts are visible on the website.
- Search and retrieval crawlers are allowed in `robots.txt`. Private app routes
  are excluded, and the cloud server also sets `X-Robots-Tag: noindex`.
- Cloud handles permanent www/HTML-alias redirects and real 404s.
- The root 32-character `.txt` file verifies IndexNow URL submissions. It grants
  no account/API access and is intentionally served publicly.
- Update sandbox wording, product reference and schema together if billing mode,
  plan prices or integration availability change. Sitemap dates reflect actual
  content edits, not deployment times.

Validate before and after deploying:

```sh
node scripts/check-seo.mjs
node scripts/check-seo.mjs https://claudeshare.space
```

Crawl access is technical eligibility, not confirmed indexing or ranking.
Search Console ownership and sitemap submission are separate from the deployed
sitemap; do not claim Google indexing without Search Console evidence.
