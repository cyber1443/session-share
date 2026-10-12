'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, EventEnvelope, Participant, SessionSnapshot } from '@session-share/protocol'

type Tab = 'feed' | 'chat'

/**
 * Two streams. Chat is the people talking to each other, and nothing else --
 * agents and the session talking over them is what made it unreadable. The
 * feed is everything else: the session's own messages, the agents' reports and
 * instructions, and what happened, newest first.
 */
const QUIET = new Set(['participant.connection', 'participant.activity', 'usage.recorded', 'chat.message'])

type FeedItem =
  | { kind: 'message'; at: number; key: string; message: ChatMessage }
  | { kind: 'event'; at: number; key: string; envelope: EventEnvelope }

export function Room({
  snapshot,
  events,
  onPost,
  filterTaskId,
  onClearFilter,
}: {
  snapshot: SessionSnapshot
  events: EventEnvelope[]
  onPost: (body: string) => Promise<void>
  filterTaskId: string | null
  onClearFilter: () => void
}) {
  const [tab, setTab] = useState<Tab>('chat')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [unread, setUnread] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)

  const scoped = useMemo(
    () => (filterTaskId ? snapshot.chat.filter((m) => m.taskRef === filterTaskId) : snapshot.chat),
    [snapshot.chat, filterTaskId],
  )
  const human = useMemo(() => scoped.filter((m) => m.authorKind === 'human' && !m.directive), [scoped])

  const feed = useMemo(() => {
    const items: FeedItem[] = [
      ...scoped
        .filter((m) => m.authorKind !== 'human' || m.directive)
        .map((message) => ({ kind: 'message' as const, at: message.createdAt, key: `m${message.id}`, message })),
      ...(filterTaskId ? [] : events)
        .filter((envelope) => !QUIET.has(envelope.body.type))
        .map((envelope) => ({ kind: 'event' as const, at: envelope.ts, key: `e${envelope.seq}`, envelope })),
    ]
    return items.sort((a, b) => b.at - a.at).slice(0, 300)
  }, [scoped, events, filterTaskId])

  useEffect(() => {
    if (tab === 'chat') {
      setUnread(0)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
    } else {
      setUnread((count) => count + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [human.length])

  const post = async () => {
    const body = draft.trim()
    if (!body) return
    setSending(true)
    try {
      await onPost(body)
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
          ? human.map((message) => (
              <ChatLine key={message.id} message={message} participants={snapshot.participants} />
            ))
          : feed.map((item) =>
              item.kind === 'message' ? (
                <FeedMessage key={item.key} message={item.message} participants={snapshot.participants} />
              ) : (
                <FeedLine key={item.key} envelope={item.envelope} participants={snapshot.participants} />
              ),
            )}

        {tab === 'chat' && human.length === 0 ? (
          <p className="text-mute">
            Nobody has said anything yet. This is for the people; what the agents and the session say is in the feed.
          </p>
        ) : null}
      </div>

      {tab === 'chat' ? (
        <div className="flex gap-2 border-t border-edge p-3">
          <input
            className="field"
            placeholder="message… use #task-id to pin it to a node"
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
          <button className="btn" disabled={!draft.trim() || sending} onClick={() => void post()}>
            send
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** A message from the session or an agent, in the feed with the events around it. */
function FeedMessage({ message, participants }: { message: ChatMessage; participants: Participant[] }) {
  const author = participants.find((p) => p.id === message.authorId)
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const to = message.mentions
    .map((id) => participants.find((p) => p.id === id)?.displayName)
    .filter(Boolean)
    .join(', ')
  return (
    <div className="flex gap-3 leading-relaxed">
      <span className="shrink-0 text-mute/60">{time}</span>
      <span className="shrink-0 text-mute">
        {message.authorKind === 'system' ? 'session' : `${author?.displayName ?? 'someone'}'s Claude`}
      </span>
      {message.directive ? (
        <span className="shrink-0 text-accent" title="an instruction to an agent">
          ▸{to ? ` ${to}` : ''}
        </span>
      ) : null}
      <span className="min-w-0 whitespace-pre-line break-words text-neutral-300">{message.body}</span>
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
      <span className="shrink-0 text-mute">{author?.displayName ?? 'someone'}</span>
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
    case 'ticket.attached':
      return `${body.attachments.length} picture(s) added to a ticket`
    case 'ticket.needsHuman':
      return body.value ? 'a ticket now waits for a human look before it ships' : 'a ticket no longer waits for a human look'
    case 'ticket.humanCheck':
      return body.check?.passed ? 'tried by hand -- it works' : 'hand check cleared'
    case 'ticket.merged':
      return `ticket merged as #${body.prNumber} -- done`
    case 'ticket.deleted':
      return 'deleted a ticket'
    case 'ticket.edited':
      return `edited "${body.title}"`
    case 'ticket.due':
      return body.dueAt ? `set a ticket due ${new Date(body.dueAt).toLocaleDateString()}` : 'cleared a due date'
    case 'ticket.sprint':
      return body.sprintId ? 'planned a ticket into a sprint' : 'moved a ticket to the backlog'
    case 'subticket.added':
      return `added subticket "${body.subticket.title}"`
    case 'subticket.updated':
      return `subticket "${body.title}" → ${body.state}`
    case 'subticket.members':
      return `subticket now has ${body.members.length} member(s)`
    case 'subticket.removed':
      return 'removed a subticket'
    case 'comment.added':
      return `commented: ${body.comment.body.slice(0, 80)}`
    case 'comment.edited':
      return 'edited a comment'
    case 'comment.deleted':
      return 'deleted a comment'
    case 'sprint.created':
      return `created sprint "${body.sprint.name}"`
    case 'sprint.updated':
      return `sprint "${body.sprint.name}" is ${body.sprint.state}`
    case 'sprint.deleted':
      return 'deleted a sprint'
    case 'profile.updated':
      return body.profile.dailyLimit === null
        ? 'removed their daily token limit'
        : `set a daily token limit of ${body.profile.dailyLimit.toLocaleString()} units`
    case 'terminal.opened':
      return 'opened a terminal on a ticket'
    case 'terminal.helm':
      return body.driver ? 'took the helm of a terminal' : 'handed a terminal to Claude'
    case 'terminal.closed':
      return `a terminal ended${body.exitCode !== null ? ` (exit ${body.exitCode})` : ''}`
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
    case 'usage.recorded':
      return `${body.outputTokens} tokens out over ${body.turns} turn(s)`
    case 'merge.queue':
      return `merge queue: ${body.entries.length} waiting`
    case 'merge.conflict':
      return `conflict on ${body.taskId}: ${body.paths.join(', ')}`
    case 'integration.pr':
      return `integration PR #${body.prNumber}`
  }
}
