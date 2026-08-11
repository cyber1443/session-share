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

const WS_URL = process.env.NEXT_PUBLIC_SESSION_SHARE_WS ?? 'ws://127.0.0.1:4310/ws'
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
  const closed = useRef(false)

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
    closed.current = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const applyEvent = (envelope: EventEnvelope) => {
      stateRef.current.apply(envelope)
      setEvents((current) =>
        current.some((e) => e.seq === envelope.seq) ? current : [...current, envelope].slice(-1000),
      )
    }

    const connect = async () => {
      if (closed.current) return
      try {
        const { ticket } = await api.wsTicket()
        const socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}`)
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
          socketRef.current = null
          for (const pending of pendingRef.current.values()) {
            pending.reject(new Error('Connection closed'))
          }
          pendingRef.current.clear()
          if (closed.current) return
          setStatus('reconnecting')
          timer = setTimeout(connect, backoff.current)
          backoff.current = Math.min(backoff.current * 2, RECONNECT_MAX_MS)
        }
      } catch (connectError) {
        if (closed.current) return
        setError(connectError instanceof Error ? connectError.message : 'connection failed')
        setStatus('reconnecting')
        timer = setTimeout(connect, backoff.current)
        backoff.current = Math.min(backoff.current * 2, RECONNECT_MAX_MS)
      }
    }

    void connect()

    return () => {
      closed.current = true
      if (timer) clearTimeout(timer)
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
