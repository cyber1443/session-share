'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, EventEnvelope, Participant, SessionSnapshot } from '@session-share/protocol'

type Tab = 'feed' | 'chat'

/**
 * Feed and chat share one surface because they are one timeline: "what happened"
 * and "what we said about it" are the same conversation, and splitting them
 * makes people read neither.
 */
export function Room({
  snapshot,
  events,
  onPost,
  filterTaskId,
  onClearFilter,
}: {
  snapshot: SessionSnapshot
  events: EventEnvelope[]
  onPost: (body: string, directive: boolean) => Promise<void>
  filterTaskId: string | null
  onClearFilter: () => void
}) {
  const [tab, setTab] = useState<Tab>('chat')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [unread, setUnread] = useState(0)
  /**
   * The room is also a terminal. In `run` mode the message is delivered into
   * the other participants' Claude Code sessions and acted on there, so the
   * mode is explicit and sticky rather than inferred from what you typed --
   * "make it dark" should not silently reach two agents because it read like
   * an instruction.
   */
  const [mode, setMode] = useState<'say' | 'run'>('say')
  const scroller = useRef<HTMLDivElement>(null)

  const messages = useMemo(
    () => (filterTaskId ? snapshot.chat.filter((m) => m.taskRef === filterTaskId) : snapshot.chat),
    [snapshot.chat, filterTaskId],
  )

  useEffect(() => {
    if (tab === 'chat') {
      setUnread(0)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
    } else {
      setUnread((count) => count + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.chat.length])

  const post = async () => {
    const body = draft.trim()
    if (!body) return
    setSending(true)
    try {
      await onPost(body, mode === 'run')
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-edge px-4 py-2 text-xs uppercase tracking-wider">
        <button
          className={tab === 'chat' ? 'text-neutral-200' : 'text-mute hover:text-neutral-400'}
          onClick={() => setTab('chat')}
        >
          chat{unread > 0 && tab !== 'chat' ? ` (${unread})` : ''}
        </button>
        <button
          className={tab === 'feed' ? 'text-neutral-200' : 'text-mute hover:text-neutral-400'}
          onClick={() => setTab('feed')}
        >
          feed
        </button>
        {filterTaskId ? (
          <button className="ml-auto text-accent hover:text-accent/80" onClick={onClearFilter}>
            #{filterTaskId} ×
          </button>
        ) : null}
      </div>

      <div ref={scroller} className="flex-1 space-y-1 overflow-y-auto px-4 py-3 text-xs">
        {tab === 'chat'
          ? messages.map((message) => (
              <ChatLine key={message.id} message={message} participants={snapshot.participants} />
            ))
          : events
              .slice(-200)
              .reverse()
              .map((envelope) => (
                <FeedLine
                  key={`${envelope.seq}`}
                  envelope={envelope}
                  participants={snapshot.participants}
                />
              ))}

        {tab === 'chat' && messages.length === 0 ? (
          <p className="text-mute">
            Empty room. Agents post here too — read it before touching anything shared.
          </p>
        ) : null}
      </div>

      {tab === 'chat' ? (
        <div className="space-y-2 border-t border-edge p-3">
          <div className="flex gap-2">
            <div className="flex shrink-0 overflow-hidden rounded border border-edge text-[10px] uppercase tracking-wider">
              <button
                className={`px-2 py-1 ${mode === 'say' ? 'bg-neutral-800 text-neutral-200' : 'text-mute hover:text-neutral-400'}`}
                onClick={() => setMode('say')}
                title="Talk to the people in the session"
              >
                say
              </button>
              <button
                className={`px-2 py-1 ${mode === 'run' ? 'bg-accent/20 text-accent' : 'text-mute hover:text-neutral-400'}`}
                onClick={() => setMode('run')}
                title="Send this into the other participants' Claude Code sessions"
              >
                run
              </button>
            </div>
            <input
              className="field"
              placeholder={
                mode === 'run'
                  ? 'instruction for the other agents… @login to aim it at one'
                  : 'message… use #task-id to pin it to a node'
              }
              value={draft}
              disabled={sending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void post()
                }
              }}
            />
            <button
              className={mode === 'run' ? 'btn btn-accent' : 'btn'}
              disabled={!draft.trim() || sending}
              onClick={() => void post()}
            >
              {mode === 'run' ? 'run' : 'send'}
            </button>
          </div>
          {mode === 'run' ? (
            <p className="text-[10px] text-mute">
              Delivered into the other participants&apos; Claude Code — they act on it when their
              current turn ends. File leases still apply.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ChatLine({
  message,
  participants,
}: {
  message: ChatMessage
  participants: Participant[]
}) {
  const author = participants.find((p) => p.id === message.authorId)
  return (
    <div className="flex gap-2 leading-relaxed">
      <span className="shrink-0 text-mute">{author?.displayName ?? 'system'}</span>
      {message.authorKind === 'agent' ? (
        <span className="shrink-0 text-sky-400/70">agent</span>
      ) : null}
      {message.directive ? <span className="shrink-0 text-accent">▸run</span> : null}
      {message.taskRef ? <span className="shrink-0 text-accent">#{message.taskRef}</span> : null}
      <span className="min-w-0 break-words text-neutral-300">{message.body}</span>
    </div>
  )
}

function FeedLine({
  envelope,
  participants,
}: {
  envelope: EventEnvelope
  participants: Participant[]
}) {
  const actor = participants.find((p) => p.id === envelope.actorId)
  const time = new Date(envelope.ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return (
    <div className="flex gap-3 leading-relaxed">
      <span className="shrink-0 text-mute/60">{time}</span>
      <span className="shrink-0 text-mute">{actor?.displayName ?? 'server'}</span>
      <span className="min-w-0 break-words text-neutral-400">{describe(envelope)}</span>
    </div>
  )
}

/** One line per event. A wall of JSON is not a feed. */
function describe(envelope: EventEnvelope): string {
  const body = envelope.body
  switch (body.type) {
    case 'session.created':
      return `opened "${body.session.title}"`
    case 'session.phase':
      return `phase → ${body.phase}`
    case 'session.lead':
      return 'became session lead'
    case 'participant.joined':
      return `${body.participant.displayName} joined`
    case 'participant.left':
      return 'left'
    case 'participant.connection':
      return body.connected ? 'reconnected' : 'went offline'
    case 'participant.attached':
      return `attached a checkout at ${body.repoPath}`
    case 'participant.activity':
      return body.activity.detail
    case 'ticket.created':
      return `opened "${body.ticket.title}"`
    case 'ticket.members':
      return `ticket now has ${body.members.length} member(s)`
    case 'ticket.state':
      return `ticket → ${body.state}`
    case 'ticket.verified':
      return body.verification.passed
        ? `verified: ${body.verification.how}`
        : `ran it and it is broken: ${body.verification.summary.slice(0, 60)}`
    case 'ticket.shipped':
      return body.prNumber ? `ticket shipped as #${body.prNumber}` : 'ticket closed'
    case 'plan.requested':
      return `asked for a split: ${body.goal.slice(0, 80)}`
    case 'decomposition.assigned':
      return `assigned ${body.assignments.length} task(s)`
    case 'task.assigned':
      return body.assigneeId ? `${body.taskId} assigned` : `${body.taskId} unassigned`
    case 'decomposition.proposed':
      return body.validation.ok
        ? `proposed a split of ${body.decomposition.tasks.length} tasks`
        : `proposed a split — ${body.validation.issues.filter((i) => i.severity === 'error').length} blocking problem(s)`
    case 'decomposition.approval':
      return body.satisfied ? 'approved — the split is final' : 'approved the split'
    case 'decomposition.rejected':
      return `rejected the split: ${body.reason}`
    case 'contract.committed':
      return `landed the contract on ${body.branch}`
    case 'tasks.seeded':
      return `${body.tasks.length} tasks are live`
    case 'task.state':
      return `${body.taskId} → ${body.state}`
    case 'task.branch':
      return `${body.taskId} on ${body.branch}`
    case 'task.test':
      return `${body.taskId} tests ${body.result.passed ? 'passed' : 'failed'} — ${body.result.summary}`
    case 'lease.granted':
      return `took the lease on ${body.lease.taskId}`
    case 'lease.released':
      return `released ${body.taskId}`
    case 'lease.denied':
      return `blocked from editing ${body.path} (held for ${body.heldByTaskId})`
    case 'handoff.requested':
      return `asked for ${body.request.path}`
    case 'handoff.resolved':
      return body.granted ? 'granted a handoff' : 'refused a handoff'
    case 'chat.message':
      return `${body.message.directive ? 'sent the agents' : 'said'}: ${body.message.body.slice(0, 80)}`
    case 'merge.queue':
      return `merge queue: ${body.entries.length} waiting`
    case 'merge.conflict':
      return `conflict on ${body.taskId}: ${body.paths.join(', ')}`
    case 'integration.pr':
      return `integration PR #${body.prNumber}`
  }
}
