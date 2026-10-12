'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventEnvelope } from '@session-share/protocol'

export type Sound = 'done' | 'shipped' | 'message' | 'alert'

/** Notes per sound, as [frequency Hz, start s, length s]. */
const NOTES: Record<Sound, { wave: OscillatorType; gain: number; notes: Array<[number, number, number]> }> = {
  done: { wave: 'sine', gain: 0.18, notes: [[659.25, 0, 0.18], [880, 0.09, 0.28]] },
  shipped: { wave: 'sine', gain: 0.18, notes: [[523.25, 0, 0.2], [659.25, 0.1, 0.2], [783.99, 0.2, 0.2], [1046.5, 0.3, 0.45]] },
  message: { wave: 'sine', gain: 0.12, notes: [[987.77, 0, 0.14]] },
  alert: { wave: 'triangle', gain: 0.2, notes: [[740, 0, 0.16], [554.37, 0.16, 0.3]] },
}

const STORAGE_KEY = 'ss:sound'
/** A burst of events -- a split landing, a merge train -- plays once, not as a drum roll. */
const GAP_MS = 400

let context: AudioContext | null = null

/**
 * Synthesized rather than shipped as files: the plugin bundle stays small and
 * there is nothing to fetch with a seat's token first.
 */
function play(sound: Sound): void {
  if (typeof window === 'undefined') return
  context ??= new AudioContext()
  // Browsers start it suspended until the page has been clicked.
  if (context.state === 'suspended') void context.resume()
  const { wave, gain, notes } = NOTES[sound]
  const start = context.currentTime + 0.01
  for (const [frequency, at, length] of notes) {
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = wave
    oscillator.frequency.value = frequency
    envelope.gain.setValueAtTime(0, start + at)
    envelope.gain.linearRampToValueAtTime(gain, start + at + 0.01)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + at + length)
    oscillator.connect(envelope).connect(context.destination)
    oscillator.start(start + at)
    oscillator.stop(start + at + length + 0.02)
  }
}

/**
 * What a live event sounds like to the person at this board, if anything.
 * Their own doing is silent: you do not need telling that you just did it.
 */
export function soundFor(envelope: EventEnvelope, meId: string | null): Sound | null {
  const { body } = envelope
  const others = !meId || envelope.actorId !== meId
  switch (body.type) {
    case 'ticket.shipped':
    case 'ticket.merged':
      return 'shipped'
    case 'task.state':
      if (body.state === 'merged') return 'done'
      if (body.state === 'failed') return 'alert'
      return null
    case 'ticket.verified':
      return body.verification.passed ? 'done' : 'alert'
    case 'subticket.updated':
      return body.state === 'done' && others ? 'done' : null
    case 'handoff.requested':
      return meId && body.request.holderId === meId ? 'alert' : null
    case 'chat.message': {
      const { message } = body
      if (meId && message.authorId === meId) return null
      if (meId && message.mentions.includes(meId as never)) return 'alert'
      return message.authorKind === 'system' ? null : 'message'
    }
    case 'comment.added':
      return others ? 'message' : null
    default:
      return null
  }
}

/** Sounds for live events, with an on/off switch remembered per browser. */
export function useSounds() {
  const [on, setOn] = useState(true)
  const last = useRef(0)
  /** The seat at this board; set by the page once the snapshot says which it is. */
  const meRef = useRef<string | null>(null)
  const onRef = useRef(on)
  onRef.current = on

  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(STORAGE_KEY) !== 'off')
    } catch {
      // Storage blocked: sounds stay on for this visit.
    }
  }, [])

  const toggle = useCallback(() => {
    setOn((current) => {
      const next = !current
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
      } catch {
        // Not remembered; still switched for this visit.
      }
      if (next) play('message')
      return next
    })
  }, [])

  /** For the live socket: only events as they happen, never a replayed backlog. */
  const onEvent = useCallback((envelope: EventEnvelope) => {
    if (!onRef.current) return
    const sound = soundFor(envelope, meRef.current)
    if (!sound) return
    const now = Date.now()
    if (now - last.current < GAP_MS) return
    last.current = now
    try {
      play(sound)
    } catch {
      // No audio on this machine; the board works the same without it.
    }
  }, [])

  return { on, toggle, onEvent, me: meRef }
}
