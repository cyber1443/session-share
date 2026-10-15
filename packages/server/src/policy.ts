import type { SessionId } from '@session-share/protocol'
import type { User } from './auth.js'

/** Who is asking: enough to look them up, whichever path they came in by. */
export type PolicyUser = Pick<User, 'id' | 'githubLogin' | 'displayName'>

/**
 * Who may do what on an oauth server, beyond "is signed in with GitHub".
 *
 * Without a policy every signed-in user can see, open and join every session,
 * which is right for a team's own deployment and wrong for a shared one. A
 * deployment that serves several teams supplies a policy and decides -- by
 * organisation, plan, seat count, whatever it keeps -- without the coordination
 * server having to know any of that exists.
 *
 * Refusals are returned as the sentence to show the person, or null to allow.
 * None of this applies in peer mode, where holding the invite is the rule.
 */
export interface AccessPolicy {
  /** Before a signed-in user opens a new session. */
  mayCreateSession?(user: PolicyUser): string | null
  /** Once a session exists, so the policy can record whose it is. */
  sessionCreated?(user: PolicyUser, sessionId: SessionId): void
  /**
   * Whether a signed-in user may see a session at all: list it, read it, or be
   * handed a way into it. A seat in the session always counts as yes.
   */
  maySeeSession?(user: PolicyUser, sessionId: SessionId): boolean
  /**
   * Before a user takes a seat they do not already have. Someone returning to
   * their own seat is never asked -- refusing that would lock people out of
   * work they already hold.
   */
  mayJoinSession?(user: PolicyUser, sessionId: SessionId): string | null
}
