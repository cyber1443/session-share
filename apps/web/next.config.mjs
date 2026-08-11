/**
 * Two shapes, one app.
 *
 * In development the board runs on its own port and proxies to the
 * coordination server, so the session cookie and the OAuth callback stay
 * same-origin. For a peer session it is exported to static files and served BY
 * the coordination server, so hosting is one process on one port rather than
 * two things to start and a proxy between them.
 */
const SERVER = process.env.SESSION_SHARE_URL ?? 'http://127.0.0.1:4310'
const isExport = process.env.SESSION_SHARE_EXPORT === '1'

/** @type {import('next').NextConfig} */
const config = isExport
  ? {
      output: 'export',
      // Directory-style output (`board/index.html`) so a plain static file
      // server resolves `/board` without rewrite rules of its own.
      trailingSlash: true,
      images: { unoptimized: true },
      /**
       * The export is committed, so a random build id per run would rewrite
       * every asset path and churn the diff on rebuilds that changed nothing.
       */
      generateBuildId: () => 'session-share',
    }
  : {
      async rewrites() {
        return [
          { source: '/auth/:path*', destination: `${SERVER}/auth/:path*` },
          { source: '/api/:path*', destination: `${SERVER}/api/:path*` },
          { source: '/sessions/:ref/snapshot', destination: `${SERVER}/sessions/:ref/snapshot` },
        ]
      },
    }

export default config
