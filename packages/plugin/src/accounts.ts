import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STATE_DIR } from './daemon.js'

/**
 * Accounts on servers that verify identity -- a hosted session-share, or a
 * team's own deployment with GitHub sign-in. Keyed by origin, because a token
 * from one server means nothing to another. Peer servers need none of this:
 * there the invite is the credential.
 */
const ACCOUNTS_FILE = join(STATE_DIR, 'accounts.json')

export interface Account {
  token: string
  githubLogin: string
  displayName: string
}

/** A sign-in the person has been shown a code for but has not approved yet. */
export interface PendingSignIn {
  deviceCode: string
  userCode: string
  verifyUrl: string
  expiresAt: number
}

interface AccountsFile {
  accounts: Record<string, Account>
  pending: Record<string, PendingSignIn>
}

export function originOf(url: string): string {
  return new URL(url).origin
}

function read(): AccountsFile {
  if (!existsSync(ACCOUNTS_FILE)) return { accounts: {}, pending: {} }
  try {
    const parsed = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) as Partial<AccountsFile>
    return { accounts: parsed.accounts ?? {}, pending: parsed.pending ?? {} }
  } catch {
    return { accounts: {}, pending: {} }
  }
}

/** Tokens are logins: owner-readable only. */
function write(file: AccountsFile): void {
  mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true })
  const temporary = `${ACCOUNTS_FILE}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, ACCOUNTS_FILE)
}

export function accountFor(serverUrl: string): Account | null {
  return read().accounts[originOf(serverUrl)] ?? null
}

export function saveAccount(serverUrl: string, account: Account): void {
  const file = read()
  const origin = originOf(serverUrl)
  file.accounts[origin] = account
  delete file.pending[origin]
  write(file)
}

export function forgetAccount(serverUrl: string): Account | null {
  const file = read()
  const origin = originOf(serverUrl)
  const had = file.accounts[origin] ?? null
  delete file.accounts[origin]
  delete file.pending[origin]
  write(file)
  return had
}

export function pendingFor(serverUrl: string): PendingSignIn | null {
  const pending = read().pending[originOf(serverUrl)]
  return pending && pending.expiresAt > Date.now() ? pending : null
}

export function savePending(serverUrl: string, pending: PendingSignIn): void {
  const file = read()
  file.pending[originOf(serverUrl)] = pending
  write(file)
}

type Refusal = { error?: string; message?: string; reason?: string }

/** Asks the server for a code to show the person. */
export async function startSignIn(serverUrl: string, label: string): Promise<PendingSignIn> {
  const response = await fetch(new URL('/api/device', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  const payload = (await response.json()) as PendingSignIn & Refusal
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `sign-in failed (${response.status})`)
  const pending = {
    deviceCode: payload.deviceCode,
    userCode: payload.userCode,
    verifyUrl: payload.verifyUrl,
    expiresAt: payload.expiresAt,
  }
  savePending(serverUrl, pending)
  return pending
}

/**
 * Waits for the person to approve the code, up to `waitMs`. Returns null if
 * they have not yet -- the code stays pending, so asking again carries on
 * rather than starting over.
 */
export async function finishSignIn(
  serverUrl: string,
  pending: PendingSignIn,
  waitMs: number,
  intervalMs = 3000,
): Promise<Account | null> {
  const deadline = Math.min(Date.now() + waitMs, pending.expiresAt)
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/api/device/token', serverUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: pending.deviceCode }),
    })
    if (response.status === 200) {
      const payload = (await response.json()) as {
        token: string
        user: { githubLogin: string; displayName: string }
      }
      const account = {
        token: payload.token,
        githubLogin: payload.user.githubLogin,
        displayName: payload.user.displayName,
      }
      saveAccount(serverUrl, account)
      return account
    }
    if (response.status !== 202) {
      const payload = (await response.json().catch(() => ({}))) as Refusal
      throw new Error(payload.message ?? `sign-in failed (${response.status})`)
    }
    await new Promise((done) => setTimeout(done, intervalMs))
  }
  return null
}

/** Revokes the token on the server too, so a copy of the file is worth nothing. */
export async function signOut(serverUrl: string): Promise<Account | null> {
  const account = accountFor(serverUrl)
  if (account) {
    await fetch(new URL('/api/account/logout', serverUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${account.token}` },
    }).catch(() => null)
  }
  return forgetAccount(serverUrl)
}
