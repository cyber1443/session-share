'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, type Me } from '@/lib/api'

interface AuthState {
  me: Me | null
  devLogin: boolean
  githubConfigured: boolean
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [devLogin, setDevLogin] = useState(false)
  const [githubConfigured, setGithubConfigured] = useState(true)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const result = await api.me()
      setMe(result.user)
      setDevLogin(result.devLogin)
      setGithubConfigured(result.githubConfigured)
    } catch {
      setMe(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(async () => {
    await api.logout()
    setMe(null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <AuthContext.Provider value={{ me, devLogin, githubConfigured, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth outside AuthProvider')
  return context
}

export function SignIn() {
  const { refresh, devLogin, githubConfigured } = useAuth()
  const [login, setLogin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signInAsDev = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.devLogin(login.trim())
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 px-6">
      <div>
        <h1 className="text-lg tracking-tight">session-share</h1>
        <p className="mt-2 text-sm leading-relaxed text-mute">
          Split one issue across several devs and their Claude Codes. Your Claude account stays on
          your machine — this only coordinates who owns which files.
        </p>
      </div>

      <a
        href={`/auth/github?redirect_to=${encodeURIComponent('/')}`}
        className={`btn text-center ${githubConfigured ? '' : 'pointer-events-none opacity-40'}`}
      >
        Continue with GitHub
      </a>
      {!githubConfigured ? (
        <p className="-mt-6 text-xs text-mute">
          GitHub sign-in needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the server.
        </p>
      ) : null}

      {devLogin ? (
        <div className="panel space-y-3 p-4">
          <p className="text-xs uppercase tracking-wider text-mute">Local development</p>
          <p className="text-xs leading-relaxed text-mute">
            No OAuth App registered yet. This shortcut works only over loopback and only while
            <code className="mx-1 text-neutral-400">SESSION_SHARE_DEV_LOGIN=1</code> is set.
          </p>
          <input
            className="field"
            placeholder="github handle, e.g. alice"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && login.trim()) void signInAsDev()
            }}
          />
          <button
            className="btn w-full"
            disabled={!login.trim() || busy}
            onClick={() => void signInAsDev()}
          >
            {busy ? 'signing in…' : 'sign in locally'}
          </button>
        </div>
      ) : null}

      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  )
}
