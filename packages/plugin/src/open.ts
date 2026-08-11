import { spawn } from 'node:child_process'

/**
 * Opens the board in whatever the machine uses for a browser.
 *
 * Hosting or joining without seeing the board is the failure mode this exists
 * to remove: the session is a live picture of what two agents are doing, and a
 * URL printed in a terminal is a picture nobody looks at. Best effort by
 * design -- a headless box or a locked-down browser is not a reason to fail a
 * join, so the caller only ever learns whether it worked.
 */
export function openInBrowser(url: string): boolean {
  if (process.env.SESSION_SHARE_NO_OPEN === '1') return false

  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]

  try {
    const child = spawn(command as string, args as string[], {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => undefined) // no browser on this machine; not fatal
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * The board URL for a packed invite. The invite is what seats the browser; the
 * handle is passed along so it seats itself -- the plugin has just joined as
 * this person, and asking them again on the page it opened for them would make
 * "opens automatically" mean "opens, then asks a question".
 */
export function boardUrl(serverUrl: string, packedInvite: string, as?: string | null): string {
  const suffix = as ? `&as=${encodeURIComponent(as)}` : ''
  return `${serverUrl.replace(/\/$/, '')}/board/?join=${packedInvite}${suffix}`
}
