import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { AuthContext } from './auth-context'

function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let componentActive = true

    async function loadSession() {
      const { data, error } = await supabase.auth.getSession()

      if (!componentActive) {
        return
      }

      if (error) {
        console.error('Unable to load authentication session:', error.message)
      }

      setSession(data.session ?? null)
      setLoading(false)
    }

    loadSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (componentActive) {
        setSession(nextSession)
        setLoading(false)
      }
    })

    return () => {
      componentActive = false
      subscription.unsubscribe()
    }
  }, [])

  async function signOut() {
    const { error } = await supabase.auth.signOut()

    if (error) {
      throw error
    }

    localStorage.removeItem('agriterrain_remember_session')
    setSession(null)
  }

  const contextValue = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signOut,
    }),
    [session, loading],
  )

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  )
}

export default AuthProvider