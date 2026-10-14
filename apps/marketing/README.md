# Session Share marketing website

Live: https://session-share-two.vercel.app

Standalone, dependency-free marketing website. The application board remains in `apps/web`.

## Preview

From the repository root:

```sh
python3 -m http.server 4173 --directory apps/marketing
```

Open http://localhost:4173. No build or install step is needed.

## Deploy

From `apps/marketing`, with an authenticated Vercel CLI:

```sh
vercel link --project session-share
vercel --prod
```

The Vercel project uses this directory as the deployment source. Its configuration explicitly disables framework detection, installation, and building. Do not deploy the repository root as the marketing site.

## Content and interactions

- Three-stage interactive, illustrative workflow demo with keyboard tab navigation.
- Claude Code and GitHub reflect the existing product workflow.
- Jira, Slack, and Linear are explicitly labeled **In development**. Roadmap dialogs describe planned functionality only.
- Copyable install commands, mobile navigation, accessible native FAQ and integration dialogs.
- Self-hosted fonts with OFL licenses, favicon, social preview, reduced-motion support, and security headers.

Product claims and installation instructions are based on the repository README. Keep the roadmap status synchronized with actual releases.
