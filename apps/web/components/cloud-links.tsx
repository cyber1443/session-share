'use client'
import { useEffect, useState } from 'react'

/** Only the hosted service exposes these destinations; peer boards stay standalone. */
export function CloudLinks() {
  const [cloud, setCloud] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/cloud/health', { signal: controller.signal })
      .then(async (response) => { if (response.ok && (await response.json()).ok) setCloud(true) })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  if (!cloud) return null
  return <nav aria-label="Cloud navigation" className="flex items-center gap-4 text-xs"><a className="text-mute hover:text-accent" href="/workspace">Workspace</a><a className="text-mute hover:text-accent" href="/account">Account</a></nav>
}
