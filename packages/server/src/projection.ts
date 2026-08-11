/**
 * The fold lives in `protocol` so the browser runs byte-identical code: the
 * board applies the same events to the same reducer the server does, which is
 * the only way a live client and the log can be guaranteed to agree.
 */
export { CLAIM_CAP, SessionState } from '@session-share/protocol'
