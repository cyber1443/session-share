'use client'

import { useEffect, useState } from 'react'

/**
 * Reads a query parameter without `useSearchParams`, which forces a Suspense
 * boundary and bails out of static export. The board ships as static files
 * served by the coordination server itself, so it has to survive prerendering
 * with no request to read.
 */
export function useQueryParam(name: string): { value: string | null; ready: boolean } {
  const [state, setState] = useState<{ value: string | null; ready: boolean }>({
    value: null,
    ready: false,
  })

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setState({ value: params.get(name), ready: true })
  }, [name])

  return state
}

/** Drops a parameter from the address bar without reloading the page. */
export function stripQueryParam(name: string): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(name)) return
  url.searchParams.delete(name)
  window.history.replaceState({}, '', url.toString())
}
