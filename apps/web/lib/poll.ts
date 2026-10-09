'use client'

import { useEffect, useState } from 'react'

/**
 * Reads something now and again every `everyMs` while the view is mounted.
 * History and GitHub are not events on the socket, so a tab that shows them
 * asks for them; the last good answer stays on screen through a failed read.
 */
export function usePoll<T>(read: () => Promise<T>, everyMs: number, key: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const load = () =>
      read()
        .then((value) => {
          if (!live) return
          setData(value)
          setError(null)
        })
        .catch((failure: Error) => {
          if (live) setError(failure.message)
        })
    void load()
    const timer = setInterval(load, everyMs)
    return () => {
      live = false
      clearInterval(timer)
    }
    // `read` is rebuilt every render; `key` is what actually changes what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, everyMs])

  return { data, error }
}
