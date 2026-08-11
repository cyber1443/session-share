/**
 * Everything the browser talks to is proxied to the coordination server, so the
 * app is one origin: the session cookie works, OAuth callbacks land in the right
 * place, and there is no CORS anywhere.
 */
const SERVER = process.env.SESSION_SHARE_URL ?? 'http://127.0.0.1:4310'

/** @type {import('next').NextConfig} */
export default {
  async rewrites() {
    return [
      { source: '/auth/:path*', destination: `${SERVER}/auth/:path*` },
      { source: '/api/:path*', destination: `${SERVER}/api/:path*` },
      { source: '/sessions/:ref/snapshot', destination: `${SERVER}/sessions/:ref/snapshot` },
    ]
  },
}
