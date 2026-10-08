'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SessionState,
  type ActivityFrame,
  type ClientCommand,
  type CommandResultMap,
  type EventEnvelope,
  type ServerMessage,
  type SessionSnapshot,
} from '@session-share/protocol'
import { api } from './api'

/**
 * Same origin when the coordination server is also serving this page, which is
 * the peer-mode shape. In development the board is on its own port and needs to
 * be told where the server is, since a WebSocket cannot be proxied by a rewrite.
 */
function wsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SESSION_SHARE_WS
  if (configured) return configured
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'error'

interface Pending {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
}

/**
 * The board applies events with the same reducer the server uses, so a live
 * client and the log cannot drift. On reconnect it replays from the last seq it
 * saw rather than refetching, which is what makes a dropped wifi connection a
 * non-event rather than a page reload.
 */
export function useLiveSession(sessionRef: string) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [activity, setActivity] = useState<Record<string, string>>({})
  /** Kept for the feed; the fold above is what actually drives state. */
  const [events, setEvents] = useState<EventEnvelope[]>([])

  const stateRef = useRef(new SessionState())
  const socketRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef(new Map<string, Pending>())
  const reqCounter = useRef(0)
  const backoff = useRef(RECONNECT_MIN_MS)

  const publish = useCallback(() => {
    if (!stateRef.current.session) return
    setSnapshot(stateRef.current.snapshot())
  }, [])

  const send = useCallback(<T extends ClientCommand['type']>(
    command: Extract<ClientCommand, { type: T }>,
  ): Promise<CommandResultMap[T]> => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'))
    }
    const reqId = `w${reqCounter.current++}`
    return new Promise((resolve, reject) => {
      pendingRef.current.set(reqId, { resolve: resolve as (d: unknown) => void, reject })
      socket.send(JSON.stringify({ kind: 'cmd', v: 1, reqId, command }))
    })
  }, [])

  const sendFrame = useCallback((frame: ActivityFrame) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ kind: 'frame', v: 1, frame }))
    }
  }, [])

  useEffect(() => {
    /**
     * Local to this run of the effect, not a ref shared between runs. With a
     * shared flag, switching sessions cleared it for the new run before the old
     * socket's close event arrived -- so the old socket reconnected itself, and
     * two loops ran side by side, one of them for a session nobody was looking at.
     */
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    /**
     * A different session is a different log. Folding its events onto the
     * previous session's state, and resuming from the previous session's seq,
     * showed a mixture of both until a reload.
     */
    stateRef.current = new SessionState()
    backoff.current = RECONNECT_MIN_MS
    setSnapshot(null)
    setEvents([])
    setActivity({})
    setStatus('connecting')
    setError(null)

    const retry = () => {
      if (disposed || timer) return
      setStatus('reconnecting')
      timer = setTimeout(() => {
        timer = null
        void connect()
      }, backoff.current)
      backoff.current = Math.min(backoff.current * 2, RECONNECT_MAX_MS)
    }

    const applyEvent = (envelope: EventEnvelope) => {
      stateRef.current.apply(envelope)
      setEvents((current) =>
        current.some((e) => e.seq === envelope.seq) ? current : [...current, envelope].slice(-1000),
      )
    }

    const connect = async () => {
      if (disposed) return
      try {
        const { ticket } = await api.wsTicket()
        if (disposed) return
        const socket = new WebSocket(`${wsUrl()}?ticket=${encodeURIComponent(ticket)}`)
        socketRef.current = socket

        socket.onopen = () => {
          backoff.current = RECONNECT_MIN_MS
          const fromSeq = stateRef.current.seq >= 0 ? stateRef.current.seq + 1 : null
          // Identity comes from the ws ticket, so the board asserts none.
          send({
            type: 'session.join',
            sessionRef,
            githubLogin: null,
            displayName: null,
            repoPath: null,
            machineId: null,
            fromSeq,
          })
            .then((result) => {
              // A cold join arrives as state; a resume arrives as a sync backlog.
              if (result.snapshot) stateRef.current.hydrate(result.snapshot)
              setStatus('live')
              setError(null)
              publish()
            })
            .catch((joinError: Error) => {
              setError(joinError.message)
              setStatus('error')
            })
        }

        socket.onmessage = (raw) => {
          if (disposed) return
          const message = JSON.parse(raw.data as string) as ServerMessage
          switch (message.kind) {
            case 'ack': {
              pendingRef.current.get(message.reqId)?.resolve(message.data)
              pendingRef.current.delete(message.reqId)
              break
            }
            case 'err': {
              pendingRef.current.get(message.reqId)?.reject(new Error(message.message))
              pendingRef.current.delete(message.reqId)
              break
            }
            case 'event': {
              applyEvent(message.event)
              publish()
              break
            }
            case 'sync': {
              for (const envelope of message.events) applyEvent(envelope)
              if (!message.more) {
                setStatus('live')
                publish()
              }
              break
            }
            case 'frame': {
              // Ephemeral by design: never logged, never replayed, lost on reload.
              const frame = message.frame
              if (frame.type === 'agent.line' && frame.taskId) {
                const taskId = frame.taskId
                setActivity((current) => ({ ...current, [taskId]: frame.text }))
              }
              break
            }
          }
        }

        socket.onclose = () => {
          // Only the socket this run owns may clear the slot or reconnect.
          if (socketRef.current === socket) socketRef.current = null
          if (disposed) return
          for (const pending of pendingRef.current.values()) {
            pending.reject(new Error('Connection closed'))
          }
          pendingRef.current.clear()
          retry()
        }
      } catch (connectError) {
        if (disposed) return
        setError(connectError instanceof Error ? connectError.message : 'connection failed')
        retry()
      }
    }

    void connect()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      for (const pending of pendingRef.current.values()) pending.reject(new Error('Connection closed'))
      pendingRef.current.clear()
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [sessionRef, publish, send])

  const readyTaskIds = useMemo(() => {
    if (!snapshot) return new Set<string>()
    return new Set(
      snapshot.tasks.filter((t) => t.state === 'ready' && t.ownerId === null).map((t) => t.id),
    )
  }, [snapshot])

  return { snapshot, status, error, activity, events, send, sendFrame, readyTaskIds }
}
