import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  INVITE_PREFIX,
  findInvite,
  isLoopbackUrl,
  packInvite,
  unpackInvite,
  type RepoRef,
  type SessionSnapshot,
  type TaskState,
} from '@session-share/protocol'
import { CommandError, accountJoin, pair, peerJoin, runCommand } from './client.js'
import { accountFor, finishSignIn, originOf, pendingFor, signOut, startSignIn } from './accounts.js'
import { downloadPictures, uploadPicture } from './files.js'
import { readConfig, writeConfig, type SessionConfig } from './config.js'
import { HOST_HEADER, ensureDaemon, hostKey, probe, publicUrlOverride, stopDaemon, type Health } from './daemon.js'
import { describeDirectives, markCaughtUp, peekDirectives, pendingDirectives } from './inbox.js'
import { startAutopilot } from './autopilot.js'
import { ensureTerminalHost, stopTerminalHost } from './terminal-launch.js'
import { LOG_BRANCH } from './mirror.js'
import { ensureTunnel, stopTunnel } from './tunnel.js'
import { catchUpFromMirror, mirrorOnce, restoreFromMirror, startMirror, type Restored } from './mirror-sync.js'
import { boardUrl, openInBrowser } from './open.js'
import {
  addWorktree,
  baseBranch,
  checkoutBranch,
  contractBranch,
  fetch as gitFetch,
  taskBranch,
} from './git.js'
import { readPreferences, writePreferences } from './preferences.js'
import { registerGitTools } from './tools-git.js'
import { localIdentity, repoRemote, repoRoot } from './identity.js'

const DEFAULT_SERVER_URL = process.env.SESSION_SHARE_URL ?? 'http://127.0.0.1:4310'

/** Session slugs appear in branch names and URLs, so they stay boring. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'session'
  )
}

/**
 * Who is asking a server to open or re-share a session: on this machine's own
 * server, the host credential (see server/auth.ts hostCredential); on one that
 * verifies identity, the account token from /ss:login.
 */
type Credential = Record<string, string>
const hostCredential = (): Credential => ({ [HOST_HEADER]: hostKey() })

async function createSession(
  serverUrl: string,
  input: { slug: string; title: string; repo: RepoRef; issueRef: string | null },
  credential: Credential = hostCredential(),
): Promise<{ sessionId: string; slug: string; invite: string | null }> {
  const response = await fetch(new URL('/api/sessions', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...credential },
    body: JSON.stringify(input),
  })
  const payload = (await response.json()) as {
    sessionId?: string
    slug?: string
    invite?: string | null
    error?: string
    message?: string
  }
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? 'could not create session')
  return {
    sessionId: payload.sessionId!,
    slug: payload.slug!,
    invite: payload.invite ?? null,
  }
}

/** Re-mints an invite for a session that already exists on this server. */
async function mintInvite(
  serverUrl: string,
  slug: string,
  credential: Credential = hostCredential(),
): Promise<{ invite: string; repo: RepoRef | null }> {
  const response = await fetch(new URL(`/api/sessions/${slug}/invite`, serverUrl), {
    method: 'POST',
    headers: credential,
  })
  const payload = (await response.json()) as {
    invite?: string
    repo?: RepoRef | null
    message?: string
    error?: string
  }
  if (!response.ok || !payload.invite) {
    throw new Error(payload.message ?? payload.error ?? 'could not mint an invite')
  }
  return { invite: payload.invite, repo: payload.repo ?? null }
}

/** Short and stable: enough to tell two folders of the same name apart. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}

/**
 * If splitting just landed on *this* agent, say so here rather than leaving it
 * to arrive at the end of the turn.
 *
 * The queue is delivered when a turn ends, and the agent asking this question is
 * mid-turn -- so waiting would mean stopping, and the person would have to poke
 * it to start something they just asked for.
 */
function splitHint(
  cfg: SessionConfig,
  ticket: { title: string; state: string; id: string },
  plannerId: string | null,
): string {
  if (plannerId && plannerId === cfg.participantId) {
    return [
      '',
      'You are splitting it. Do it now, in this turn: read the repository and call',
      `ss_propose with ticketId: ${ticket.id}. Then it goes on the board for someone to start.`,
    ].join('\n')
  }
  if (plannerId) return 'Someone else was asked to split it; it appears on the board when they do.'
  if (ticket.state === 'plan') {
    return 'The others have been told and can join. Nothing is split until someone runs ss_ticket_start (or presses start on the board) -- alone is fine.'
  }
  return ''
}

/**
 * Fails a join before it starts, with the reason rather than the symptom.
 *
 * "That invite is not valid for this server" is what the *server* can say, and
 * it is nearly always wrong about the cause: the token is fine, the guest just
 * reached a different server -- usually their own, because the invite carried a
 * loopback address. Only this side can tell the difference, because only this
 * side knows which server the invite claims to come from.
 */
async function checkReachable(url: string, expectedServerId: string | null): Promise<Health> {
  const health = await probe(url, 4000)

  if (!health) {
    throw new Error(
      [
        `Nothing answered at ${url}.`,
        '',
        isLoopbackUrl(url)
          ? 'That address means "this machine", so the invite was minted by a host bound to loopback. Ask them to re-run /ss:host -- their invite cannot reach them from anywhere else.'
          : 'Check that you are on the same network as the host, that their machine is awake, and that their firewall allows incoming connections on that port. If you are not on the same network, they need a tunnel.',
      ].join('\n'),
    )
  }

  if (expectedServerId && health.serverId && health.serverId !== expectedServerId) {
    throw new Error(
      [
        `${url} answered, but it is not the server that minted this invite.`,
        `  invite expects: ${expectedServerId}`,
        `  answered:       ${health.serverId}`,
        '',
        isLoopbackUrl(url)
          ? 'The address inside the invite is loopback, so on your machine it points at your own session-share. The host must re-run /ss:host so the invite carries their network address.'
          : 'Another session-share is listening on that address. The host should re-host, or free the port.',
      ].join('\n'),
    )
  }
  return health
}

/** The board for a session on a server that signs people in, rather than seating them by invite. */
function accountBoardUrl(serverUrl: string, slug: string): string {
  return `${serverUrl.replace(/\/$/, '')}/board/?s=${encodeURIComponent(slug)}`
}

function signInFirst(serverUrl: string): Error {
  return new Error(
    [
      `${originOf(serverUrl)} verifies who you are, and this machine is not signed in to it.`,
      `Run /ss:login ${originOf(serverUrl)} first, then try again.`,
    ].join('\n'),
  )
}

/**
 * The agent's own handle on the session. These tools exist so Claude can take
 * part in the coordination rather than being narrated by it: it claims its own
 * work, reports its own progress, and talks in the room when it discovers
 * something the other agent needs to know before it acts.
 */
const REPO_ROOT = process.env.SESSION_SHARE_REPO ?? process.cwd()

function config(): SessionConfig {
  const found = readConfig(REPO_ROOT)
  if (!found) {
    throw new Error('This repo is not attached to a session. Run /ss:join first.')
  }
  return found
}

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})

async function snapshot(cfg: SessionConfig): Promise<SessionSnapshot> {
  const response = await fetch(new URL(`/sessions/${cfg.sessionRef}/snapshot`, cfg.serverUrl), {
    headers: cfg.participantToken ? { authorization: `Bearer ${cfg.participantToken}` } : {},
  })
  if (!response.ok) throw new Error(`Could not read the session: ${response.status}`)
  return (await response.json()) as SessionSnapshot
}

interface RepoDescription {
  title: string
  remote: Awaited<ReturnType<typeof repoRemote>>
  repo: RepoRef
  slug: string
  sameRepo: (stored: RepoRef | null) => boolean
}

async function describeRepo(root: string, given: string | null | undefined): Promise<RepoDescription> {
  /**
   * A session is the repository, not a piece of work -- tickets are the
   * pieces. Naming it after the work was a leftover from when a session
   * held exactly one plan, and it made every new session need a decision
   * nobody had a reason to make.
   */
  const title = given?.trim() || basename(root)
  const remote = await repoRemote(root)
  const repo: RepoRef = {
    owner: remote?.owner ?? 'local',
    name: remote?.name ?? basename(root),
    baseBranch: await baseBranch(root),
    remoteUrl: remote?.remoteUrl ?? root,
  }

  /**
   * The slug names the repository, so it comes from what identifies one:
   * the remote, or failing that the path. The folder name alone does not --
   * two unrelated checkouts both called `app` used to share a slug, and the
   * second host silently resumed the first one's session.
   */
  const slug = given?.trim()
    ? slugify(title)
    : remote
      ? slugify(`${remote.owner}-${remote.name}`)
      : `${slugify(basename(root)).slice(0, 33)}-${shortHash(root)}`
  const sameRepo = (stored: RepoRef | null) =>
    Boolean(stored) &&
    (remote
      ? stored!.owner === repo.owner && stored!.name === repo.name
      : stored!.remoteUrl === repo.remoteUrl)
  return { title, remote, repo, slug, sameRepo }
}

/**
 * Hosting on a server somebody else runs: nothing starts on this machine, no
 * tunnel, no host key. The account from /ss:login opens the session and the
 * server's own rules decide what that account may do -- a plan's session or
 * seat limit comes back as the refusal, word for word.
 */
async function hostOnServer(
  root: string,
  server: string,
  described: RepoDescription,
  given: string | null | undefined,
  issueRef: string | null | undefined,
): Promise<string> {
  const serverUrl = originOf(server)
  const health = await probe(serverUrl, 5000)
  if (!health) throw new Error(`Nothing answered at ${serverUrl}. Check the address, or host on this machine with server: "local".`)
  if (health.mode !== 'oauth') {
    throw new Error(`${serverUrl} is a peer server with no accounts. Join one of its sessions with an invite instead.`)
  }
  const account = accountFor(serverUrl)
  if (!account) throw signInFirst(serverUrl)
  const credential = { authorization: `Bearer ${account.token}` }
  const { title, repo, slug, sameRepo } = described

  const resume = async (candidate: string | undefined) => {
    if (!candidate) return null
    try {
      const existing = await mintInvite(serverUrl, candidate, credential)
      return sameRepo(existing.repo) ? { invite: existing.invite, resumed: true, slug: candidate } : null
    } catch {
      return null
    }
  }
  const open = async (candidate: string) => {
    try {
      const fresh = await createSession(serverUrl, { slug: candidate, title, repo, issueRef: issueRef ?? null }, credential)
      return { invite: fresh.invite, resumed: false, slug: candidate }
    } catch (error) {
      // Taken by this account's own session for this repo: carry on in it. Taken by anyone else: try another name.
      if (!String(error).includes('is taken')) throw error
      return resume(candidate)
    }
  }

  const attached = readConfig(root)
  const sameServer = attached ? originOf(attached.serverUrl) === serverUrl : false
  const created =
    (given?.trim() || !sameServer ? null : await resume(attached?.sessionRef)) ??
    (await open(slug)) ??
    (await open(`${slug.slice(0, 33)}-${shortHash(repo.remoteUrl)}`)) ??
    (await open(`${slug.slice(0, 26)}-${slugify(account.githubLogin).slice(0, 13)}`))
  if (!created?.invite) {
    throw new Error(`Sessions named "${slug}" on ${serverUrl} belong to someone else. Pass a title to name this one.`)
  }

  const joined = await accountJoin(serverUrl, created.invite, account.token, root)
  const cfg: SessionConfig = {
    serverUrl,
    sessionRef: joined.sessionRef,
    participantId: joined.participantId,
    participantToken: joined.participantToken,
    githubLogin: joined.githubLogin,
    displayName: joined.displayName,
    repoPath: root,
  }
  writeConfig(root, cfg)
  await markCaughtUp(cfg)
  ensureTerminalHost(root)

  const packed = packInvite({ url: serverUrl, token: created.invite, serverId: health.serverId ?? null })
  const board = accountBoardUrl(serverUrl, joined.sessionRef)
  const opened = readPreferences().openBoard && openInBrowser(board)
  return [
    created.resumed
      ? `Resumed "${title}" on ${serverUrl} as ${joined.displayName}.`
      : `Hosting "${title}" on ${serverUrl} as ${joined.displayName}.`,
    '',
    'Send your teammate this line:',
    `  /ss:join ${packed}`,
    '',
    `They sign in once with /ss:login ${serverUrl}; the invite alone does not let anyone in.`,
    opened ? `Board opened: ${board}` : `Board: ${board}`,
    '',
    `The session lives on ${serverUrl}, so it keeps going when this machine sleeps.`,
    `Every edit in ${basename(root)} is now checked against this session's file leases.`,
  ].join('\n')
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'session-share', version: '0.1.0' })

  server.registerTool(
    'ss_host',
    {
      description:
        'Start hosting a session for this repository. Brings up a local coordination server if one is not already running, attaches this checkout, and returns the single string to send a teammate. Work is organised as tickets on the board, so the session does not need a name of its own.',
      inputSchema: {
        title: z
          .string()
          .nullish()
          .describe('Rarely needed: the session is named after the repository by default'),
        issueRef: z.string().nullish().describe('Issue URL, if there is one'),
        expose: z
          .enum(['lan', 'loopback'])
          .nullish()
          .describe(
            'lan lets teammates on the same network connect; loopback is this machine only. Defaults to your saved preference.',
          ),
        publicUrl: z
          .string()
          .nullish()
          .describe(
            'The address teammates should dial when it is not one this machine can see: a tunnel (https://x.trycloudflare.com), a Tailscale name, a port forward. Defaults to SESSION_SHARE_PUBLIC_URL.',
          ),
        tunnel: z
          .boolean()
          .nullish()
          .describe(
            'Open a Cloudflare quick tunnel so teammates on any network can join, and put its public address in the invite. Needs cloudflared installed. Defaults to your saved preference.',
          ),
        server: z
          .string()
          .nullish()
          .describe(
            'A hosted session-share to open the session on instead of this machine, e.g. https://cloud.example.com. Needs /ss:login there first. Defaults to the server you signed in to; "local" forces this machine.',
          ),
      },
    },
    async ({ title: given, issueRef, expose, publicUrl: givenPublicUrl, tunnel, server: givenServer }) => {
      const root = await repoRoot(REPO_ROOT)
      const { title, remote, repo, slug, sameRepo } = await describeRepo(root, given)

      const server = givenServer?.trim() || readPreferences().server
      if (server && server !== 'local') return text(await hostOnServer(root, server, { title, remote, repo, slug, sameRepo }, given, issueRef))

      const identity = await localIdentity()
      let publicUrl = publicUrlOverride(givenPublicUrl)
      const tunnelled = !publicUrl && (tunnel ?? readPreferences().tunnel)
      const daemon = await ensureDaemon({ expose: expose ?? (tunnelled ? 'loopback' : readPreferences().expose) })
      const loopback = `http://127.0.0.1:${daemon.port}`
      // Anyone, anywhere: the tunnel forwards to loopback, so nothing on the LAN is opened.
      if (tunnelled) publicUrl = await ensureTunnel(daemon.port)
      // What goes in the invite: what the host said, else what this machine can see.
      const dialUrl = publicUrl ?? daemon.url

      /**
       * Hosting the same thing twice rejoins it rather than failing. The host's
       * machine sleeping is a normal way for a session to pause, and the
       * documented recovery is to run this again -- so it has to work. But only
       * for the same repository: a slug that is taken by some other repo gets a
       * suffix, not that repo's session.
       */
      const open = async (candidate: string) => {
        try {
          const fresh = await createSession(loopback, {
            slug: candidate,
            title,
            repo,
            issueRef: issueRef ?? null,
          })
          return { invite: fresh.invite, resumed: false, slug: candidate }
        } catch (error) {
          if (!String(error).includes('is taken')) throw error
          const existing = await mintInvite(loopback, candidate)
          return sameRepo(existing.repo) ? { invite: existing.invite, resumed: true, slug: candidate } : null
        }
      }
      /**
       * Only ever resumes. Before 0.10 the slug was the bare folder name, and
       * this checkout may already be attached to a session under some other
       * name; re-hosting has to land back in it, not open an empty one beside
       * it while every guest stays on the old one.
       */
      const resume = async (candidate: string | undefined) => {
        if (!candidate) return null
        try {
          const existing = await mintInvite(loopback, candidate)
          return sameRepo(existing.repo) ? { invite: existing.invite, resumed: true, slug: candidate } : null
        } catch {
          return null
        }
      }
      /**
       * The repository remembers sessions this server has never seen: a new
       * laptop, a wiped one, or the last host gone for good. Restoring comes
       * before opening anything new, so hosting again means carrying on.
       */
      let restored: Restored | null = null
      const restore = async () => {
        restored = await restoreFromMirror(
          root,
          loopback,
          remote ? { owner: remote.owner, name: remote.name } : null,
          given?.trim() ? slug : null,
        ).catch(() => null)
        return restored?.invite ? { invite: restored.invite, resumed: true, slug: restored.slug } : null
      }
      const attached = readConfig(root)
      const created =
        (given?.trim() ? null : await resume(attached?.sessionRef)) ??
        (given?.trim() ? null : await resume(slugify(basename(root)))) ??
        (await restore()) ??
        (await open(slug)) ??
        (await open(`${slug.slice(0, 33)}-${shortHash(repo.remoteUrl)}`)) ??
        null
      if (!created) {
        throw new Error(
          `Sessions named "${slug}" on this server belong to other repositories. Pass a title to name this one.`,
        )
      }

      if (!created.invite) {
        throw new Error('This server verifies identity with GitHub; use the board to invite people.')
      }
      // A session this server had, but that another machine hosted on since.
      const caughtUp = created.resumed && !restored ? await catchUpFromMirror(root, loopback, created.slug) : 0
      const memory = restored as Restored | null

      // Everything a guest needs in one string: where to dial, how to get in,
      // and which server minted it so they can tell if they reached the wrong one.
      const health = await probe(loopback)
      const packed = packInvite({
        url: dialUrl,
        token: created.invite,
        serverId: health?.serverId ?? null,
      })
      const joined = await peerJoin(loopback, created.invite, identity, root)

      const cfg: SessionConfig = {
        serverUrl: loopback,
        sessionRef: joined.sessionRef,
        participantId: joined.participantId,
        participantToken: joined.participantToken,
        githubLogin: joined.githubLogin,
        displayName: joined.displayName,
        repoPath: root,
      }
      writeConfig(root, cfg)
      await markCaughtUp(cfg) // the room starts here; do not replay an old session at the agent
      ensureTerminalHost(root)

      // The host's own browser is on this machine; the tunnel is for everyone else.
      const board = boardUrl(publicUrl ? loopback : daemon.url, packed, joined.githubLogin)
      const opened = readPreferences().openBoard && openInBrowser(board)
      const loopbackOnly = isLoopbackUrl(dialUrl)

      return text(
        [
          created.resumed
            ? `Resumed hosting "${title}" as ${identity.displayName}.`
            : `Hosting "${title}" as ${identity.displayName}.`,
          memory
            ? `Restored from the repository's ${LOG_BRANCH} branch: ${memory.upToSeq + 1} events, last saved ${new Date(memory.updatedAt).toLocaleString()}. Everyone else re-joins with the invite below and gets their own seat and tasks back.`
            : caughtUp > 0
              ? `Caught up ${caughtUp} event(s) from the ${LOG_BRANCH} branch that happened while this server was away.`
              : '',
          '',
          'Send your teammate this line:',
          `  /ss:join ${packed}`,
          '',
          opened ? `Board opened: ${board}` : `Board: ${board}`,
          '',
          loopbackOnly
            ? [
                'This invite only works on this machine: the server is bound to loopback,',
                'so the address inside it points at whatever is running on the other person\'s',
                'own port 4310. Re-run with expose="lan"' +
                  (readPreferences().expose === 'lan'
                    ? ' -- and check you are on a network, because no LAN address was found.'
                    : ' to let a teammate on your network in.'),
              ].join('\n')
            : publicUrl
              ? `Teammates dial ${publicUrl}. Anyone who has the invite can join; anyone who does not, cannot.`
              : `Reachable on your network at ${daemon.url}. Anyone who has the invite can join; anyone who does not, cannot.`,
          '',
          `Every edit in ${basename(root)} is now checked against this session's file leases.`,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_join',
    {
      description:
        'Attach this checkout to a session. Accepts an ssx_ invite from a teammate (peer session, no login) or an ssj_ code from a hosted board.',
      inputSchema: {
        code: z.string().describe('The ssx_ invite or ssj_ code you were sent'),
        serverUrl: z
          .string()
          .nullish()
          .describe(
            'For ssj_ codes, the server to redeem at. For ssx_ invites, an address to dial instead of the one inside the invite -- for when the host is behind a tunnel or on Tailscale and the invite names an address you cannot reach.',
          ),
      },
    },
    async ({ code, serverUrl }) => {
      const root = await repoRoot(REPO_ROOT)
      // Accept the invite, the whole `/ss:join …` line, or a pasted board URL.
      const trimmed = findInvite(code) ?? code.trim()
      const packed = unpackInvite(trimmed)

      if (!packed && trimmed.startsWith(INVITE_PREFIX)) {
        throw new Error(
          'That looks like an invite but it is damaged -- most likely it was cut short or wrapped when it was copied. Ask for it again, or have the host re-run /ss:host.',
        )
      }
      /**
       * The invite names the address the host could see. Across a tunnel or a
       * tailnet that may be one the guest cannot reach, and the only fix used
       * to be a re-host -- so the guest can say where to dial instead. The
       * invite's server id still has to match, so this cannot point a guest at
       * the wrong server unnoticed.
       */
      const dial = packed ? (serverUrl ? publicUrlOverride(serverUrl)! : packed.url) : null
      const health = packed ? await checkReachable(dial!, packed.serverId ?? null) : null
      /**
       * A server that verifies identity takes the invite as "which session"
       * only; who is joining comes from this machine's account there.
       */
      const verified = health?.mode === 'oauth'
      const account = verified ? accountFor(dial!) : null
      if (verified && !account) throw signInFirst(dial!)

      const result = packed
        ? account
          ? await accountJoin(dial!, packed.token, account.token, root)
          : await peerJoin(dial!, packed.token, await localIdentity(), root)
        : await pair(serverUrl ?? DEFAULT_SERVER_URL, trimmed, root)

      const cfg: SessionConfig = {
        serverUrl: dial ?? serverUrl ?? DEFAULT_SERVER_URL,
        sessionRef: result.sessionRef,
        participantId: result.participantId,
        participantToken: result.participantToken,
        githubLogin: result.githubLogin,
        displayName: result.displayName,
        repoPath: root,
      }
      const path = writeConfig(root, cfg)
      await markCaughtUp(cfg)
      ensureTerminalHost(root)

      const board = !packed
        ? null
        : verified
          ? accountBoardUrl(dial!, result.sessionRef)
          : boardUrl(
              dial!,
              dial === packed.url ? trimmed : packInvite({ ...packed, url: dial! }),
              result.githubLogin,
            )
      const opened = Boolean(board) && readPreferences().openBoard && openInBrowser(board!)

      return text(
        [
          `Joined "${result.sessionTitle}" as ${result.displayName}.`,
          board ? (opened ? `Board opened: ${board}` : `Board: ${board}`) : '',
          `Config at ${path}.`,
          `Every edit in ${basename(root)} is now checked against the session's file leases.`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_board',
    {
      description:
        'Open the live board for the session this checkout is attached to, in the browser. Use it when the board was closed or never opened.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const response = await fetch(new URL(`/api/sessions/${cfg.sessionRef}/invite`, cfg.serverUrl), {
        method: 'POST',
        headers: cfg.participantToken ? { authorization: `Bearer ${cfg.participantToken}` } : {},
      })
      const payload = (await response.json()) as { invite?: string; message?: string }
      if (!response.ok || !payload.invite) {
        throw new Error(payload.message ?? 'Could not get a board link for this session.')
      }

      const health = await probe(cfg.serverUrl)
      if (health?.mode === 'oauth') {
        const board = accountBoardUrl(cfg.serverUrl, cfg.sessionRef)
        return text(openInBrowser(board) ? `Opened ${board}` : board)
      }
      const board = boardUrl(
        cfg.serverUrl,
        packInvite({ url: cfg.serverUrl, token: payload.invite, serverId: health?.serverId ?? null }),
        cfg.githubLogin,
      )
      return text(openInBrowser(board) ? `Opened ${board}` : board)
    },
  )

  server.registerTool(
    'ss_worktree',
    {
      description:
        'Create a separate working tree of this repository for a session, so several sessions can run against one clone at the same time. Returns the directory to open a second Claude Code in.',
      inputSchema: {
        title: z
          .string()
          .describe('What that session is for; also names the directory and the branch'),
        issueRef: z.string().nullish(),
        /** An existing session to join there instead of hosting a new one. */
        invite: z.string().nullish().describe('An ssx_ invite, if joining a session rather than hosting one'),
      },
    },
    async ({ title, issueRef, invite }) => {
      const root = await repoRoot(REPO_ROOT)
      const slug = slugify(title)
      const path = resolve(root, '..', `${basename(root)}-${slug}`)
      const branch = `ss/${slug}/work`

      /**
       * Sessions are already independent of each other; what was missing is a
       * place to stand. One Claude Code lives in one directory, so a second
       * concurrent session needs a second directory -- and a worktree is the
       * cheap version of that.
       */
      const created = await addWorktree(root, path, branch, await baseBranch(root))

      return text(
        [
          created === 'existing'
            ? `${path} already exists -- reusing it.`
            : `Created a worktree at ${path} on ${branch}.`,
          '',
          'Open a second Claude Code there and run:',
          invite ? `  /ss:join ${invite.trim()}` : `  /ss:host ${title}`,
          '',
          `  cd ${path}`,
          '',
          'It shares this clone\'s history and remote, so pushes and fetches behave',
          'exactly as they do here. Remove it later with: git worktree remove ' + path,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_stop_host',
    {
      description:
        'Stop the coordination server running on this machine. The session is saved to the repository first, so /ss:host on this or any other machine carries on from where it stopped.',
      inputSchema: {},
    },
    async () => {
      // Saved first: whoever hosts next, here or elsewhere, starts from this.
      const attached = readConfig(await repoRoot(REPO_ROOT))
      // An account there means a server that signs people in -- never this machine's own peer server.
      if (attached && accountFor(attached.serverUrl)) {
        return text(
          `This session runs on ${originOf(attached.serverUrl)}, not on this machine, so there is nothing here to stop. It carries on without you.`,
        )
      }
      const saved = attached ? await mirrorOnce(attached).catch(() => null) : null
      stopTunnel()
      // Its terminals talk to this server; with the server gone they have nothing to do.
      if (attached) stopTerminalHost(attached.repoPath)
      const note = saved?.pushed
        ? ` The session is saved on the ${LOG_BRANCH} branch; /ss:host on any machine picks it up from there.`
        : ''
      return text(
        (await stopDaemon()) === 'stopped'
          ? `Stopped.${note}`
          : `Nothing was running. (Any stale record of one has been cleared.)${note}`,
      )
    },
  )

  server.registerTool(
    'ss_login',
    {
      description:
        'Sign this machine in to a hosted session-share (or any session-share with GitHub sign-in), so /ss:host can open sessions there and /ss:join can join them. Opens a browser page to approve a short code.',
      inputSchema: {
        serverUrl: z
          .string()
          .nullish()
          .describe('The server, e.g. https://cloud.example.com. Defaults to the one you last signed in to.'),
      },
    },
    async ({ serverUrl: given }) => {
      const target = given?.trim() || readPreferences().server
      if (!target) throw new Error('Which server? Pass its address, e.g. /ss:login https://cloud.example.com')
      const serverUrl = originOf(/^https?:\/\//.test(target) ? target : `https://${target}`)

      const health = await probe(serverUrl, 5000)
      if (!health) throw new Error(`Nothing answered at ${serverUrl}.`)
      if (health.mode !== 'oauth') {
        throw new Error(`${serverUrl} has no accounts to sign in to -- it is a peer server. Join its sessions with an invite.`)
      }

      const existing = accountFor(serverUrl)
      if (existing) {
        writePreferences({ server: serverUrl })
        return text(`Already signed in to ${serverUrl} as @${existing.githubLogin}. /ss:host opens sessions there.`)
      }

      let pending = pendingFor(serverUrl)
      if (!pending) {
        pending = await startSignIn(serverUrl, `Claude Code on ${hostname()}`)
        openInBrowser(pending.verifyUrl)
      }
      const account = await finishSignIn(serverUrl, pending, 90_000)
      if (!account) {
        return text(
          [
            `Approve this code in your browser: ${pending.userCode}`,
            `  ${pending.verifyUrl}`,
            '',
            'Then run /ss:login again to finish.',
          ].join('\n'),
        )
      }
      writePreferences({ server: serverUrl })
      return text(
        [
          `Signed in to ${serverUrl} as @${account.githubLogin}.`,
          `/ss:host now opens sessions there instead of on this machine (pass server: "local" to host here).`,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_logout',
    {
      description: 'Sign this machine out of a hosted session-share and go back to hosting on this machine.',
      inputSchema: {
        serverUrl: z.string().nullish().describe('Defaults to the server /ss:host currently uses.'),
      },
    },
    async ({ serverUrl: given }) => {
      const target = given?.trim() || readPreferences().server
      if (!target) return text('Not signed in anywhere; /ss:host runs on this machine.')
      const serverUrl = originOf(/^https?:\/\//.test(target) ? target : `https://${target}`)
      const account = await signOut(serverUrl)
      if (readPreferences().server === serverUrl) writePreferences({ server: null })
      return text(
        account
          ? `Signed @${account.githubLogin} out of ${serverUrl}. /ss:host runs on this machine again.`
          : `This machine was not signed in to ${serverUrl}.`,
      )
    },
  )

  server.registerTool(
    'ss_status',
    {
      description:
        'Current state of the session: phase, who is here, the task DAG with owners, and anything blocked.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      return text({
        phase: state.session.phase,
        contractBranch: state.session.contractBranch,
        participants: state.participants.map((p) => ({
          name: p.displayName,
          connected: p.connected,
          doing: p.activity.detail,
        })),
        tasks: state.tasks.map((t) => ({
          id: t.id,
          state: t.state,
          owner: state.participants.find((p) => p.id === t.ownerId)?.displayName ?? null,
          dependsOn: t.dependsOn,
        })),
      })
    },
  )

  server.registerTool(
    'ss_get_my_task',
    {
      description:
        'The task you currently hold, with its intent, the paths you own, what you may assume the contract provides, and the command that proves it done.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      // Merged tasks keep their owner for the record; only what is still in hand counts.
      const mine = state.tasks.find((t) => t.ownerId === cfg.participantId && t.state !== 'merged')
      if (!mine) return text('You hold no task. Use ss_claim to take the next ready one.')
      return text({
        id: mine.id,
        title: mine.title,
        intent: mine.intent,
        ownedPaths: mine.ownedPaths,
        assumes: mine.assumes,
        acceptance: mine.acceptance,
        state: mine.state,
        branch: mine.branch,
      })
    },
  )

  server.registerTool(
    'ss_get_contract',
    {
      description:
        'The contract every task was planned against: the shared types, schemas and stubs. Frozen during the build phase -- read it, do not edit it.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      /**
       * Each ticket has its own split, so the contract that matters is the one
       * behind the task in hand. With nothing held, the session's newest one.
       */
      const held = state.tasks.find((t) => t.ownerId === cfg.participantId && t.state !== 'merged')
      const ticket = held?.ticketId ? state.tickets.find((t) => t.id === held.ticketId) : undefined
      const split =
        (ticket?.decompositionId && state.decompositions?.[ticket.decompositionId]) || state.decomposition
      if (!split) return text('No decomposition yet.')
      return text({
        summary: split.contract.summary,
        files: split.contract.files.map((f) => ({
          path: f.path,
          purpose: f.purpose,
        })),
      })
    },
  )

  server.registerTool(
    'ss_inbox',
    {
      description:
        'Take whatever the session has queued for you and act on it. Use this when you have been told there is work waiting -- a split to propose, tasks to claim, a PR to open. Normally it arrives by itself at the end of a turn; this is for picking it up on demand.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const pending = await pendingDirectives(cfg, 5000)
      if (pending.length === 0) return text('Nothing waiting. The room has asked you for nothing.')

      const state = await snapshot(cfg)
      const names = new Map(state.participants.map((p) => [p.id as string, p.displayName]))
      return text(describeDirectives(pending, names))
    },
  )

  server.registerTool(
    'ss_tickets',
    {
      description:
        'The board: every ticket in this session, which column it is in, who is in it, and how its tasks are going. Read this before asking what to do next.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      const names = new Map(state.participants.map((p) => [p.id, p.displayName]))
      const waiting = await peekDirectives(cfg).catch(() => [])
      return text({
        waiting:
          waiting.length > 0
            ? `${waiting.length} instruction(s) are queued for you -- run ss_inbox to take them.`
            : undefined,
        tickets: state.tickets.map((ticket) => ({
          id: ticket.id,
          title: ticket.title,
          column: ticket.state,
          members: ticket.members.map((id) => names.get(id) ?? id),
          mine: ticket.members.includes(cfg.participantId as never),
          tasks: state.tasks
            .filter((task) => task.ticketId === ticket.id)
            .map((task) => `${task.id}: ${task.state}${task.assigneeId ? ` (${names.get(task.assigneeId)})` : ''}`),
          prNumber: ticket.prNumber,
        })),
      })
    },
  )

  server.registerTool(
    'ss_ticket_create',
    {
      description:
        'Open a ticket for a piece of work. It waits in the plan column; everyone else is told it exists and can join it, and it is split when someone runs ss_ticket_start.',
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(20_000).nullish().describe('The description the planner works from'),
        pictures: z
          .array(z.string())
          .max(20)
          .nullish()
          .describe('Paths of pictures that are part of the brief: mockups, screenshots of the bug. PNG, JPEG, GIF or WebP.'),
        needsHuman: z
          .boolean()
          .nullish()
          .describe('Hold it in verify, after its automated run passes, until a person has tried it by hand'),
      },
    },
    async ({ title, body, pictures, needsHuman }) => {
      const cfg = config()
      const attachments = []
      for (const path of pictures ?? []) attachments.push(await uploadPicture(cfg, resolve(path), 'brief'))
      const { ticket, plannerId } = await runCommand(
        cfg,
        {
          type: 'ticket.create',
          title,
          body: body ?? '',
          sprintId: null,
          attachments,
          needsHuman: needsHuman ?? false,
        },
        15_000,
      )
      return text([`Opened "${ticket.title}" (${ticket.id}).`, splitHint(cfg, ticket, plannerId)].join('\n'))
    },
  )

  server.registerTool(
    'ss_attach',
    {
      description:
        'Attach pictures to a ticket: more of the brief (kind "brief"), or evidence from running it (kind "verify") -- screenshots taken while exercising the assembled thing, each with a caption saying what it shows.',
      inputSchema: {
        ticketId: z.string(),
        kind: z.enum(['brief', 'verify']),
        files: z
          .array(z.object({ path: z.string(), caption: z.string().max(300).nullish() }))
          .min(1)
          .max(20),
      },
    },
    async ({ ticketId, kind, files }) => {
      const cfg = config()
      const attachments = []
      for (const file of files) attachments.push(await uploadPicture(cfg, resolve(file.path), kind, file.caption ?? ''))
      await runCommand(cfg, { type: 'ticket.attach', ticketId: ticketId as never, attachments }, 15_000)
      return text(`Attached ${attachments.length} picture(s) to the ticket. They show on the board.`)
    },
  )

  server.registerTool(
    'ss_ticket_files',
    {
      description:
        "Save a ticket's pictures -- its brief's mockups and screenshots, and any evidence from running it -- to this machine and return their paths, so you can look at them with Read.",
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const cfg = config()
      const state = await snapshot(cfg)
      const ticket = state.tickets.find((t) => t.id === ticketId)
      if (!ticket) return text(`No ticket "${ticketId}".`)
      if (ticket.attachments.length === 0) return text(`"${ticket.title}" has no pictures.`)
      return text({ ticket: ticket.title, pictures: await downloadPictures(cfg, ticket.attachments) })
    },
  )

  server.registerTool(
    'ss_ticket',
    {
      description:
        'Everything written on one ticket: its description, its subtickets and who is on each, its sprint and due date, and every comment. Read this before splitting or working a ticket.',
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const cfg = config()
      const state = await snapshot(cfg)
      const ticket = state.tickets.find((t) => t.id === ticketId)
      if (!ticket) return text(`No ticket "${ticketId}".`)
      const names = new Map(state.participants.map((p) => [p.id, p.displayName]))
      const sprint = (state.sprints ?? []).find((s) => s.id === ticket.sprintId)
      return text({
        id: ticket.id,
        title: ticket.title,
        column: ticket.state,
        description: ticket.body || '(none)',
        members: ticket.members.map((id) => names.get(id) ?? id),
        sprint: sprint ? `${sprint.name} (${sprint.state})` : 'backlog',
        due: ticket.dueAt ? new Date(ticket.dueAt).toISOString().slice(0, 10) : null,
        subtickets: (ticket.subtickets ?? []).map((sub) => ({
          id: sub.id,
          title: sub.title,
          state: sub.state,
          members: sub.members.map((id) => names.get(id) ?? id),
        })),
        comments: (state.comments ?? [])
          .filter((c) => c.ticketId === ticket.id)
          .map((c) => ({
            by: `${names.get(c.authorId) ?? 'someone'}${c.byAgent ? "'s Claude" : ''}`,
            at: new Date(c.createdAt).toISOString(),
            body: c.body,
          })),
      })
    },
  )

  server.registerTool(
    'ss_ticket_comment',
    {
      description:
        'Leave a comment on a ticket: a finding, a decision, a question for the people on it. It stays on the card for the next person or agent who opens it, unlike chat, which scrolls away.',
      inputSchema: { ticketId: z.string(), body: z.string().min(1).max(8000) },
    },
    async ({ ticketId, body }) => {
      await runCommand(config(), { type: 'comment.add', ticketId: ticketId as never, body, asAgent: true })
      return text('Commented. It shows on the ticket.')
    },
  )

  server.registerTool(
    'ss_subticket',
    {
      description:
        'Add a subticket to a ticket (give a title and no subticketId), or move one along (give its subticketId and a state). Subtickets are the pieces people tick off; they have no split or leases of their own.',
      inputSchema: {
        ticketId: z.string(),
        subticketId: z.string().nullish(),
        title: z.string().min(1).max(200).nullish(),
        state: z.enum(['todo', 'doing', 'done']).nullish(),
      },
    },
    async ({ ticketId, subticketId, title, state }) => {
      const cfg = config()
      if (!subticketId) {
        if (!title) return text('Give a title to add a subticket, or a subticketId to change one.')
        const { subticket } = await runCommand(cfg, { type: 'subticket.add', ticketId: ticketId as never, title })
        return text(`Added "${subticket.title}" (${subticket.id}).`)
      }
      const { subticket } = await runCommand(cfg, {
        type: 'subticket.update',
        ticketId: ticketId as never,
        subticketId,
        ...(title ? { title } : {}),
        ...(state ? { state } : {}),
      })
      return text(`"${subticket.title}" is ${subticket.state}.`)
    },
  )

  server.registerTool(
    'ss_ticket_join',
    {
      description:
        'Join a ticket. This is the consent step: the work is assigned to whoever is in, with nothing further to approve. Joining does not start the split; ss_ticket_start does.',
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const cfg = config()
      const { ticket, plannerId } = await runCommand(cfg, {
        type: 'ticket.join',
        ticketId: ticketId as never,
      })
      return text(
        [
          `In "${ticket.title}" with ${ticket.members.length - 1} other(s). Column: ${ticket.state}.`,
          splitHint(cfg, ticket, plannerId),
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_ticket_delete',
    {
      description:
        'Delete a ticket, at any stage. Its tasks and their file leases go with it. Nothing in git is touched: branches, commits and anything already merged stay exactly where they are -- this removes a card from the board, not work from the repository.',
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const { tasksRemoved } = await runCommand(config(), {
        type: 'ticket.delete',
        ticketId: ticketId as never,
      })
      return text(
        tasksRemoved > 0
          ? `Deleted, along with ${tasksRemoved} task(s). Any branches and merged work are untouched.`
          : 'Deleted. It had no tasks yet.',
      )
    },
  )

  server.registerTool(
    'ss_ticket_start',
    {
      description:
        'Start splitting a ticket. One person is enough; the split is sized for whoever is in it, so let anyone who wants in join first. The caller joins it if they had not.',
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const cfg = config()
      const { ticket, plannerId } = await runCommand(cfg, {
        type: 'ticket.start',
        ticketId: ticketId as never,
      })
      return text([`"${ticket.title}" is ${ticket.state}.`, splitHint(cfg, ticket, plannerId)].join('\n'))
    },
  )

  server.registerTool(
    'ss_ticket_approve',
    {
      description:
        'Accept a ticket\'s proposed split and start the work. Seeds the tasks and tells every member\'s agent what it owns.',
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const cfg = config()
      const { ticket } = await runCommand(cfg, {
        type: 'ticket.approve',
        ticketId: ticketId as never,
      })
      return text(`"${ticket.title}" is ${ticket.state}. Everyone in it has been told what they own.`)
    },
  )

  server.registerTool(
    'ss_ticket_verified',
    {
      description:
        'Report what happened when you ran the assembled feature -- in the browser, the simulator, the emulator, or whatever this project actually runs in. Passing sends the ticket to review; failing sends it back to whoever built the broken part.',
      inputSchema: {
        ticketId: z.string(),
        passed: z.boolean(),
        how: z
          .string()
          .max(500)
          .describe('How you exercised it: the command you ran, the URL you drove, the simulator'),
        summary: z
          .string()
          .max(2000)
          .describe('What you saw. On a failure, be specific enough that someone can fix it'),
        broke: z
          .array(z.string())
          .optional()
          .describe(
            'Failing only: the ids of the tasks the failure is on. Those tasks reopen and become claimable again. Omit only if you genuinely cannot tell -- every task reopens then',
          ),
        followUps: z
          .array(z.object({ title: z.string().min(1).max(200), body: z.string().max(4000).default('') }))
          .max(10)
          .optional()
          .describe(
            'Pass or fail: what the run turned up that is not this ticket\'s to fix -- open questions, things that need checking, bugs elsewhere. Each becomes a ticket on the board, linked back here',
          ),
      },
    },
    async ({ ticketId, passed, how, summary, broke, followUps }) => {
      const cfg = config()
      const result = await runCommand(cfg, {
        type: 'ticket.verified',
        ticketId: ticketId as never,
        passed,
        how,
        summary,
        broke: (broke ?? []) as never,
        followUps: followUps ?? [],
      })
      const { ticket } = result
      const reopened = ticket.verification?.broke ?? []
      const filed = result.followUps.length
        ? `\nFiled as follow-up tickets: ${result.followUps.map((t) => `"${t.title}"`).join(', ')}.`
        : ''
      return text(
        (passed
          ? `"${ticket.title}" verified. It is in review; open the PR with ss_ship.`
          : [
              `Recorded as broken, and the work is open again: ${reopened.join(', ') || 'nothing to reopen'}.`,
              `Everyone who built "${ticket.title}" has been told what you saw and asked to fix it.`,
              'When the last fix lands you will be asked to run it again.',
            ].join('\n')) + filed,
      )
    },
  )

  server.registerTool(
    'ss_summary',
    {
      description:
        'Post the daily summary you were asked for: where the project stands, what moved, risks and blockers, next steps. It shows on the board\'s summary tab.',
      inputSchema: {
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('The UTC day you were asked to summarize, YYYY-MM-DD'),
        narrative: z.string().min(1).max(8000).describe('Markdown, at most about 300 words'),
      },
    },
    async ({ day, narrative }) => {
      await runCommand(config(), { type: 'summary.post', day, narrative })
      return text(`Summary for ${day} posted to the board.`)
    },
  )

  server.registerTool(
    'ss_ticket_shipped',
    {
      description:
        'Record the pull request opened for a ticket. The card stays in review with the number on it -- merging is a human decision and nothing here does it.',
      inputSchema: { ticketId: z.string(), prNumber: z.number().int().nullish() },
    },
    async ({ ticketId, prNumber }) => {
      const cfg = config()
      const { ticket } = await runCommand(cfg, {
        type: 'ticket.shipped',
        ticketId: ticketId as never,
        prNumber: prNumber ?? null,
      })
      return text(
        `"${ticket.title}" has PR #${ticket.prNumber ?? '?'} open. It stays in review until someone merges it.`,
      )
    },
  )

  server.registerTool(
    'ss_propose',
    {
      description:
        'Propose a decomposition: the contract to commit first, then the tasks. The server validates it deterministically and returns every problem with a repair hint. Fix and call again.',
      inputSchema: {
        contract: z.object({
          summary: z.string(),
          files: z
            .array(
              z.object({
                path: z.string(),
                purpose: z.string(),
                contents: z.string().describe('Full file body; this is what gets committed'),
              }),
            )
            .min(1),
        }),
        tasks: z
          .array(
            z.object({
              id: z.string().describe('kebab-case, used in branch names and #chat refs'),
              title: z.string().max(80),
              intent: z.string(),
              ownedPaths: z.array(z.string()).min(1).describe('Repo-relative globs this task exclusively owns'),
              dependsOn: z.array(z.string()).default([]),
              assumes: z.array(z.string()).default([]),
              acceptance: z.object({
                testCommand: z.string().describe('Must fail now and pass when the task is done'),
                testFiles: z.array(z.string()),
                manualChecks: z.array(z.string()).default([]),
              }),
              estimateMinutes: z.number().int().min(5).max(240),
            }),
          )
          .min(1),
        ticketId: z
          .string()
          .nullish()
          .describe('The ticket being split. Given to you in the request; a valid ticket split needs no approval and starts at once.'),
      },
    },
    async ({ contract, tasks, ticketId }) => {
      const cfg = config()
      const state = await snapshot(cfg)
      const ticket = ticketId ? state.tickets.find((t) => t.id === ticketId) : null
      const result = await runCommand(cfg, {
        type: 'decomposition.propose',
        contract,
        tasks: tasks as never,
        participantCount: Math.max(ticket ? ticket.members.length : state.participants.length, 1),
        issueRef: state.session.issueRef,
        ticketId: (ticketId ?? null) as never,
      })

      if (result.validation.ok) {
        // The server balances the split across whoever has a checkout the
        // moment it lands, so report who ended up with what rather than
        // leaving the team to work it out.
        const after = await snapshot(cfg)
        const names = new Map(after.participants.map((p) => [p.id, p.displayName]))
        return text({
          accepted: true,
          decompositionId: result.decompositionId,
          maxParallel: result.validation.maxFrontier,
          warnings: result.validation.issues,
          assigned: (after.decompositions?.[result.decompositionId]?.assignments ?? after.decomposition?.assignments ?? []).map((a) => ({
            task: a.taskId,
            to: names.get(a.participantId) ?? a.participantId,
          })),
          next: ticketId
            ? 'The work has started -- a valid split needs no approval. Land the contract now with ss_land_contract if you can (you will also be sent this as an instruction), then claim your own tasks. Who does what can still be changed on the board.'
            : 'The board shows the split with the proposed assignment. Anyone can move a card; approving seeds the tasks and tells each agent what it owns.',
        })
      }
      return text({
        accepted: false,
        mustFix: result.validation.issues.filter((i) => i.severity === 'error'),
        warnings: result.validation.issues.filter((i) => i.severity === 'warning'),
      })
    },
  )

  server.registerTool(
    'ss_approve',
    {
      description:
        'Approve the current decomposition on this participant’s behalf. Once the approval rule is met the tasks are seeded.',
      inputSchema: { decompositionId: z.string() },
    },
    async ({ decompositionId }) => {
      const cfg = config()
      const result = await runCommand(cfg, {
        type: 'decomposition.approve',
        decompositionId: decompositionId as never,
      })
      return text(
        result.satisfied
          ? 'Approved. Tasks are seeded and each assignee has been told what they own; land the contract to make them claimable.'
          : `Recorded. ${result.approvals.length} approval(s) so far.`,
      )
    },
  )

  server.registerTool(
    'ss_claim',
    {
      description:
        'Claim a task and take the lease on its paths. Omit taskId to be handed the best ready task.',
      inputSchema: { taskId: z.string().nullish() },
    },
    async ({ taskId }) => {
      const cfg = config()
      const result = await runCommand(cfg, { type: 'task.claim', taskId: (taskId ?? null) as never })
      if (!result.task) return text(result.reason ?? 'Nothing to claim.')

      // Claiming puts you on the task's branch, off the contract. Working on
      // the wrong branch is the failure the whole split exists to avoid.
      const root = await repoRoot(REPO_ROOT)
      const state = await snapshot(cfg)
      const branch = taskBranch(state.session.slug, result.task.id)
      let branchNote = `on ${branch}`
      try {
        await gitFetch(root)
        await checkoutBranch(root, branch, contractBranch(state.session.slug))
        await runCommand(cfg, {
          type: 'task.branch',
          taskId: result.task.id,
          branch,
          prNumber: null,
        })
      } catch (error) {
        branchNote = `could not switch branch: ${error instanceof Error ? error.message : error}`
      }

      return text({
        claimed: result.task.id,
        branch: branchNote,
        intent: result.task.intent,
        youNowOwn: result.lease?.paths,
        acceptance: result.task.acceptance,
      })
    },
  )

  server.registerTool(
    'ss_release',
    {
      description:
        'Give a task back to the ready pool and drop its lease. With abandoned: true, take it back from someone else who has gone quiet (not heard from for 10 minutes) -- the lead or anyone on its ticket may do that, so a vanished teammate cannot hold files hostage.',
      inputSchema: {
        taskId: z.string(),
        abandoned: z
          .boolean()
          .nullish()
          .describe('The task is held by someone else who has disappeared; reclaim it for the pool'),
      },
    },
    async ({ taskId, abandoned }) => {
      const cfg = config()
      if (abandoned) {
        const { holderId } = await runCommand(cfg, { type: 'task.forceRelease', taskId: taskId as never })
        const state = await snapshot(cfg)
        const holder = state.participants.find((p) => p.id === holderId)?.displayName ?? 'its holder'
        return text(`Took ${taskId} back from ${holder}; it is claimable again and their lease is gone.`)
      }
      await runCommand(cfg, { type: 'task.release', taskId: taskId as never })
      return text(`Released ${taskId}.`)
    },
  )

  server.registerTool(
    'ss_report_progress',
    {
      description:
        'Tell the session what you are doing right now. The line streams onto your task node on the board; use it as you move between files.',
      inputSchema: {
        taskId: z.string(),
        activityLine: z.string().max(120),
        state: z
          .enum(['claimed', 'running', 'testing'])
          .nullish()
          .describe('Only when the task actually changes phase'),
      },
    },
    async ({ taskId, activityLine, state }) => {
      const cfg = config()
      await runCommand(cfg, {
        type: 'task.progress',
        taskId: taskId as never,
        state: (state ?? null) as TaskState | null,
        activityLine,
      })
      return text('ok')
    },
  )

  server.registerTool(
    'ss_check_lease',
    {
      description:
        'Ask whether you may edit these repo-relative paths before you plan work around them. The PreToolUse hook enforces the same answer on every edit.',
      inputSchema: { paths: z.array(z.string()).min(1) },
    },
    async ({ paths }) => {
      const cfg = config()
      const result = await runCommand(cfg, { type: 'lease.check', paths })
      return text(result.allowed ? 'All of those are yours to edit.' : result.denials)
    },
  )

  server.registerTool(
    'ss_request_handoff',
    {
      description:
        'Ask the current holder for one file you need. They approve or refuse on the board; nothing moves until they do.',
      inputSchema: { path: z.string(), reason: z.string().max(280).default('') },
    },
    async ({ path, reason }) => {
      const cfg = config()
      const { request } = await runCommand(cfg, { type: 'handoff.request', path, reason })
      return text(`Requested ${path} from the holder of "${request.heldByTaskId}". Request ${request.id}.`)
    },
  )

  server.registerTool(
    'ss_resolve_handoff',
    {
      description: 'Grant or refuse a handoff request for a path you hold.',
      inputSchema: { requestId: z.string(), granted: z.boolean() },
    },
    async ({ requestId, granted }) => {
      const cfg = config()
      await runCommand(cfg, { type: 'handoff.resolve', requestId, granted })
      return text(granted ? 'Granted.' : 'Refused.')
    },
  )

  server.registerTool(
    'ss_report_test',
    {
      description:
        'Report the result of the acceptance command. Passing moves the task to PR; failing marks it failed and keeps the lease.',
      inputSchema: {
        taskId: z.string(),
        passed: z.boolean(),
        command: z.string(),
        exitCode: z.number(),
        summary: z.string().max(2000),
      },
    },
    async ({ taskId, passed, command, exitCode, summary }) => {
      const cfg = config()
      await runCommand(cfg, {
        type: 'task.testResult',
        taskId: taskId as never,
        result: { passed, command, exitCode, summary, ranAt: Date.now() },
      })
      /**
       * `auto-on-green` is a standing instruction from the person, so the
       * agent is told to finish now rather than wait to be asked for /ss:done.
       */
      if (passed && readPreferences().commitPolicy === 'auto-on-green') {
        return text(
          `Recorded. Commits are set to happen on green, so finish it now: call ss_done with taskId "${taskId}" and a one-line summary.`,
        )
      }
      return text('Recorded.')
    },
  )

  server.registerTool(
    'ss_chat_post',
    {
      description:
        'Say something in the session room. Use it when you learn something the other agent must know BEFORE it acts -- a contract gap, a shared assumption that broke, a path you need. Mention a task as #task-id to pin the message to it.',
      inputSchema: {
        body: z.string().min(1).max(8000),
        taskRef: z.string().nullish(),
        directive: z
          .boolean()
          .nullish()
          .describe(
            'Deliver this into the other agents\' Claude Code sessions instead of only showing it in the room. Use @login to aim it at one person.',
          ),
      },
    },
    async ({ body, taskRef, directive }) => {
      const cfg = config()
      const { message } = await runCommand(cfg, {
        type: 'chat.post',
        body,
        taskRef: (taskRef ?? null) as never,
        asAgent: true,
        directive: directive ?? false,
      })
      return text(
        `Posted${message.taskRef ? ` on #${message.taskRef}` : ''}${message.directive ? ' as a directive -- it will run in the other agents.' : '.'}`,
      )
    },
  )

  server.registerTool(
    'ss_chat_read',
    {
      description:
        'Read the room. Worth doing before you start a task and before you touch anything shared -- the other agent may have already flagged it.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30),
        taskRef: z.string().nullish(),
      },
    },
    async ({ limit, taskRef }) => {
      const cfg = config()
      const state = await snapshot(cfg)
      const names = new Map(state.participants.map((p) => [p.id, p.displayName]))
      const { messages } = await runCommand(cfg, {
        type: 'chat.read',
        limit,
        beforeSeq: null,
        taskRef: (taskRef ?? null) as never,
        afterId: null,
      })
      return text(
        messages
          .map(
            (m) =>
              `${(m.authorId ? names.get(m.authorId) : null) ?? 'system'}${m.authorKind === 'agent' ? ' (agent)' : ''}${m.taskRef ? ` #${m.taskRef}` : ''}: ${m.body}`,
          )
          .join('\n') || '(empty room)',
      )
    },
  )

  registerGitTools(server, {
    repoRoot: () => repoRoot(REPO_ROOT),
    config,
    snapshot,
    text,
  })

  return server
}

const isEntrypoint = process.argv[1]?.endsWith('mcp.js') ?? false

if (isEntrypoint) {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  /**
   * This process outlives every turn, which is exactly what queued work needs:
   * an idle Claude Code has no turn ending to deliver on, so without something
   * alive between turns a session stops the moment someone steps away.
   */
  startAutopilot()
  startMirror()
  // Board terminals, when this machine's owner turned them on. Detached: it outlives this process.
  if (process.env.SESSION_SHARE_AUTOPILOT !== 'off') {
    try {
      ensureTerminalHost(REPO_ROOT)
    } catch {
      // A terminal host that cannot start is reported by ss_doctor, never fatal here.
    }
  }
  process.stderr.write('[session-share] mcp server ready\n')
}

export { CommandError }
