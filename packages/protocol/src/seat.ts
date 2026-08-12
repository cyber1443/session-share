import { findInvite } from './invite.js'

/**
 * Which session a peer board should show.
 *
 * There are two credentials in play and they can disagree: an invite in the URL
 * that someone was just handed, and a participant token in local storage from
 * whatever they opened last. Preferring the stored one is how a board ends up
 * showing a *previous* session -- old chat, old tasks, and participants who were
 * never invited to the session you just created -- while quietly ignoring the
 * invite in the address bar.
 *
 * So the invite wins. It is the more recent, more explicit statement of intent:
 * someone opened this link on purpose, and the token is only a memory of an
 * earlier one.
 */
export type Seat =
  /** Redeem the invite in the URL, replacing whatever token is stored. */
  | { kind: 'redeem'; invite: string }
  /** No invite: use the stored token, and ask the server which session it is for. */
  | { kind: 'stored' }
  /** Nothing to go on -- ask for a handle, or say there is nothing to show. */
  | { kind: 'ask' }

export function chooseSeat(input: { invite: string | null; hasToken: boolean }): Seat {
  const invite = input.invite ? findInvite(input.invite) : null
  if (invite) return { kind: 'redeem', invite }
  if (input.hasToken) return { kind: 'stored' }
  return { kind: 'ask' }
}
