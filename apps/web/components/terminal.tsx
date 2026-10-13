'use client'

import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { Participant, SessionSnapshot, TerminalInfo, Ticket, ViewerEvent, ViewerMessage } from '@session-share/protocol'
import { api } from '@/lib/api'
import { termUrl } from '@/lib/live'
import { ago } from '@/lib/now'

type Mode =
  | { kind: 'attach'; terminalId: string }
  | { kind: 'open'; hostId: string; prompt: string | null; drive: 'me' | 'claude' }

const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const decode = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0))

/**
 * A Claude Code in a real terminal on a ticket member's machine, from the
 * board. Anyone in the ticket can take the helm and type, or hand it to
 * Claude -- which then picks up whatever work is queued for that seat. Anyone
 * in the session can watch.
 */
export function TerminalTab({
  ticket,
  snapshot,
  slug,
  meId,
}: {
  ticket: Ticket
  snapshot: SessionSnapshot
  slug: string
  meId: string | null
}) {
  const mine = snapshot.terminals?.filter((t) => t.ticketId === ticket.id).sort((a, b) => b.startedAt - a.startedAt) ?? []
  const current = mine[0] ?? null
  const [mode, setMode] = useState<Mode | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  /**
   * Someone else opened one while this tab was showing the form: watch it. One
   * that has ended stays on screen, last frame and all, until someone moves on
   * from it -- the server forgets it ten minutes after it ends anyway.
   */
  const live = current && current.id !== dismissed
  const showing: Mode | null = mode ?? (live && current ? { kind: 'attach', terminalId: current.id } : null)

  if (showing) {
    return (
      <TerminalView
        key={showing.kind === 'attach' ? showing.terminalId : `open-${showing.hostId}`}
        mode={showing}
        ticket={ticket}
        snapshot={snapshot}
        slug={slug}
        meId={meId}
        onFailed={(message) => {
          setFailure(message)
          setMode(null)
        }}
        // Already showing it; switching modes would remount and reconnect for nothing.
        onAttached={() => undefined}
        onDismiss={(terminalId) => {
          setDismissed(terminalId)
          setMode(null)
        }}
      />
    )
  }

  return (
    <OpenForm
      ticket={ticket}
      snapshot={snapshot}
      meId={meId}
      failure={failure}
      onOpen={(hostId, prompt, drive) => {
        setFailure(null)
        setMode({ kind: 'open', hostId, prompt, drive })
      }}
    />
  )
}

function OpenForm({
  ticket,
  snapshot,
  meId,
  failure,
  onOpen,
}: {
  ticket: Ticket
  snapshot: SessionSnapshot
  meId: string | null
  failure: string | null
  onOpen: (hostId: string, prompt: string | null, drive: 'me' | 'claude') => void
}) {
  const me = snapshot.participants.find((p) => p.id === meId)
  const person = (p: Participant | undefined) => p?.userId ?? p?.id
  const inTicket = (p: Participant) =>
    ticket.members.some((id) => person(snapshot.participants.find((m) => m.id === id)) === person(p))
  const hosts = snapshot.participants.filter(
    (p) => p.repoPath && snapshot.terminalHosts?.includes(p.id) && inTicket(p),
  )
  const amMember = Boolean(me && inTicket(me))
  // Your own machine first, if it is one of them.
  const ordered = [...hosts].sort((a, b) => Number(person(b) === person(me)) - Number(person(a) === person(me)))
  const [hostId, setHostId] = useState<string>(ordered[0]?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [drive, setDrive] = useState<'me' | 'claude'>('me')
  const chosen = hosts.find((h) => h.id === hostId) ?? ordered[0]

  return (
    <div className="space-y-3">
      <p className="leading-relaxed text-neutral-400">
        Open Claude Code in a real terminal on the machine of someone in this ticket, and drive it from here — or
        hand the helm to Claude, and it picks up the work queued for that seat on its own.
      </p>

      {!snapshot.terminalHosts ? (
        <p className="text-amber-400">This server is too old for terminals. Host again with the current plugin.</p>
      ) : hosts.length === 0 ? (
        <div className="panel space-y-1 p-3 text-[11px] leading-relaxed text-mute">
          <p className="text-neutral-300">No machine in this ticket takes terminals right now.</p>
          <p>
            A terminal runs commands on someone&apos;s machine, so each person turns it on for their own:{' '}
            <span className="text-neutral-300">/ss:setup</span>, or ask their Claude to run{' '}
            <span className="text-neutral-300">ss_settings</span> with <span className="text-neutral-300">terminal: members</span>.
            Their Claude Code has to be open in the checkout once for it to start.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-mute">On whose machine</span>
            <select className="field py-1 text-xs" value={chosen?.id ?? ''} onChange={(e) => setHostId(e.target.value)}>
              {ordered.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.displayName} — {host.repoPath}
                  {person(host) === person(me) ? ' (yours)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-mute">First instruction (optional)</span>
            <textarea
              className="field min-h-16 resize-y text-xs"
              placeholder="Leave empty to start it idle."
              value={prompt}
              maxLength={4000}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-4 text-[11px] text-mute">
            <label className="flex cursor-pointer items-center gap-1">
              <input type="radio" checked={drive === 'me'} onChange={() => setDrive('me')} /> I drive
            </label>
            <label className="flex cursor-pointer items-center gap-1">
              <input type="radio" checked={drive === 'claude'} onChange={() => setDrive('claude')} /> Claude drives
            </label>
            <button
              className="btn btn-accent ml-auto"
              disabled={!chosen || !amMember}
              title={amMember ? undefined : 'Join the ticket to open a terminal on it'}
              onClick={() => chosen && onOpen(chosen.id, prompt.trim() || null, drive)}
            >
              open terminal
            </button>
          </div>
          {chosen && person(chosen) !== person(me) ? (
            <p className="text-[11px] leading-relaxed text-amber-400/80">
              This runs on {chosen.displayName}&apos;s machine, in their checkout, with file edits and shell commands
              allowed. They can see it, take the helm and stop it. Who opened it and who drove it is logged.
            </p>
          ) : null}
          {!amMember ? <p className="text-[11px] text-mute">Join the ticket to open one.</p> : null}
        </div>
      )}
      {failure ? <p className="text-[11px] text-red-400">{failure}</p> : null}
    </div>
  )
}

function TerminalView({
  mode,
  ticket,
  snapshot,
  slug,
  meId,
  onFailed,
  onAttached,
  onDismiss,
}: {
  mode: Mode
  ticket: Ticket
  snapshot: SessionSnapshot
  slug: string
  meId: string | null
  onFailed: (message: string) => void
  onAttached: (terminalId: string) => void
  onDismiss: (terminalId: string) => void
}) {
  const container = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const infoRef = useRef<TerminalInfo | null>(null)
  const [info, setInfo] = useState<TerminalInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const callbacks = useRef({ onFailed, onAttached })
  callbacks.current = { onFailed, onAttached }

  const me = snapshot.participants.find((p) => p.id === meId)
  const samePerson = (id: string | null | undefined) => {
    if (!id || !me) return false
    const other = snapshot.participants.find((p) => p.id === id)
    return id === me.id || Boolean(other?.userId && other.userId === me.userId)
  }
  const name = (id: string | null | undefined) =>
    snapshot.participants.find((p) => p.id === id)?.displayName ?? 'someone'
  const driving = samePerson(info?.driver)
  const drivingRef = useRef(false)
  drivingRef.current = driving

  const send = (message: ViewerMessage) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  useEffect(() => {
    let disposed = false
    let cleanup = () => {}

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed || !container.current) return
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: { background: '#07080a', foreground: '#e5e5e5', cursor: '#4ade80', selectionBackground: '#4ade8044' },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container.current)
      fit.fit()

      const { ticket: wsTicket } = await api.wsTicket()
      if (disposed) return term.dispose()
      const url = new URL(termUrl())
      url.searchParams.set('ticket', wsTicket)
      url.searchParams.set('session', slug)
      const socket = new WebSocket(url)
      socketRef.current = socket

      socket.onopen = () => {
        setConnection('open')
        if (mode.kind === 'attach') send({ t: 'attach', terminalId: mode.terminalId })
        else
          send({
            t: 'open',
            ticketId: ticket.id,
            hostId: mode.hostId as never,
            prompt: mode.prompt,
            drive: mode.drive,
            cols: term.cols,
            rows: term.rows,
          })
      }
      socket.onmessage = (raw) => {
        const message = JSON.parse(String(raw.data)) as ViewerEvent
        switch (message.t) {
          case 'state': {
            const previous = infoRef.current
            const first = !previous
            infoRef.current = message.terminal
            // The screen only follows a resize, so a viewer who becomes the one it is sized for --
            // attaching after a reload, or taking the helm -- says how big theirs is. The server
            // ignores everyone else's.
            const sizer = (info: TerminalInfo) => info.driver ?? info.openedBy
            if (message.terminal.status === 'running' && (!previous || sizer(previous) !== sizer(message.terminal))) {
              send({ t: 'resize', cols: term.cols, rows: term.rows })
            }
            setInfo(message.terminal)
            if (first && mode.kind === 'open') callbacks.current.onAttached(message.terminal.id)
            return
          }
          case 'replay':
          case 'output':
            term.write(decode(message.data))
            return
          case 'error':
            // Refused before there was anything to show: back to the form, with the reason.
            if (!infoRef.current) callbacks.current.onFailed(message.message)
            else setNotice(message.message)
            return
        }
      }
      socket.onclose = () => setConnection('closed')

      const typed = term.onData((data) => {
        if (!drivingRef.current) {
          setNotice(infoRef.current?.driver ? `${name(infoRef.current.driver)} has the helm.` : 'Claude has the helm.')
          return
        }
        send({ t: 'input', data: encode(data) })
      })
      const resized = term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }))
      const observer = new ResizeObserver(() => {
        try {
          fit.fit()
        } catch {
          // Not laid out yet.
        }
      })
      observer.observe(container.current)

      cleanup = () => {
        observer.disconnect()
        typed.dispose()
        resized.dispose()
        socket.close()
        term.dispose()
      }
    })().catch((error: unknown) => callbacks.current.onFailed(error instanceof Error ? error.message : 'could not connect'))

    return () => {
      disposed = true
      cleanup()
    }
    // The terminal is opened once per mount; the parent remounts it for a different one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const host = info ? snapshot.participants.find((p) => p.id === info.hostId) : null
  const status = !info ? (connection === 'closed' ? 'disconnected' : 'connecting') : info.status

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span
          className={
            status === 'running' ? 'text-accent' : status === 'exited' || status === 'disconnected' ? 'text-red-400' : 'text-amber-400'
          }
        >
          {status}
        </span>
        {host ? (
          <span className="text-mute">
            on <span className="text-neutral-300">{host.displayName}</span>&apos;s machine
          </span>
        ) : null}
        {info && info.status !== 'exited' ? (
          <span className="text-mute">
            helm:{' '}
            <span className={info.driver ? 'text-sky-400' : 'text-violet-400'}>
              {info.driver ? (driving ? 'you' : name(info.driver)) : 'Claude'}
            </span>
          </span>
        ) : null}
        {info ? <span className="text-mute/60">opened by {name(info.openedBy)} {ago(info.startedAt)}</span> : null}
        <span className="ml-auto flex gap-2">
          {info && info.status !== 'exited' ? (
            <>
              {!driving ? (
                <button className="btn btn-accent py-0.5" onClick={() => send({ t: 'helm', to: 'me' })}>
                  take the helm
                </button>
              ) : null}
              {info.driver ? (
                <button className="btn py-0.5" onClick={() => send({ t: 'helm', to: 'claude' })}>
                  let Claude drive
                </button>
              ) : null}
              <button className="btn py-0.5 hover:text-red-400" onClick={() => send({ t: 'kill' })}>
                stop
              </button>
            </>
          ) : info ? (
            <button className="btn py-0.5" onClick={() => onDismiss(info.id)}>
              new terminal
            </button>
          ) : null}
        </span>
      </div>

      <div className="relative min-h-[28rem] flex-1 border border-edge bg-ink p-1">
        <div ref={container} className="h-full w-full" />
        {info && info.status !== 'exited' && !driving ? (
          <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-mute">
            watching — {info.driver ? `${name(info.driver)} is typing` : 'Claude is driving'}
          </div>
        ) : null}
      </div>

      {info?.status === 'exited' ? (
        <p className="text-[11px] text-mute">
          Ended{info.exitCode !== null ? ` with exit ${info.exitCode}` : ''}
          {info.reason ? `: ${info.reason}` : '.'}
        </p>
      ) : info?.driver === null ? (
        <p className="text-[11px] leading-relaxed text-mute">
          Claude has the helm: work queued for {host?.displayName ?? 'that seat'} is typed in as it goes idle. Take the
          helm to type yourself.
        </p>
      ) : null}
      {notice ? <p className="text-[11px] text-amber-400">{notice}</p> : null}
    </div>
  )
}
