import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  Leaf,
  LoaderCircle,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import './Login.css'

function AuthCallback() {
  const [status, setStatus] = useState('checking')
  const [message, setMessage] = useState(
    'Confirming your email and preparing your account...',
  )

  useEffect(() => {
    let componentActive = true
    let confirmationTimer

    function markAsConfirmed(session) {
      if (!componentActive || !session?.user) {
        return
      }

      setStatus('success')
      setMessage(
        'Your email has been confirmed successfully. Your account is ready.',
      )
    }

    async function checkConfirmation() {
      const { data, error } = await supabase.auth.getSession()

      if (!componentActive) {
        return
      }

      if (error) {
        setStatus('error')
        setMessage(error.message)
        return
      }

      if (data.session) {
        markAsConfirmed(data.session)
        return
      }

      confirmationTimer = window.setTimeout(() => {
        if (componentActive) {
          setStatus('error')
          setMessage(
            'The confirmation link is invalid or has expired. Try creating the account again or request another email.',
          )
        }
      }, 10000)
    }

    checkConfirmation()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (
        event === 'SIGNED_IN' ||
        event === 'INITIAL_SESSION' ||
        event === 'USER_UPDATED'
      ) {
        markAsConfirmed(session)
      }
    })

    return () => {
      componentActive = false
      window.clearTimeout(confirmationTimer)
      subscription.unsubscribe()
    }
  }, [])

  return (
    <main className="auth-status-page">
      <section className="auth-status-card">
        <Link className="login-brand auth-status-brand" to="/">
          <span className="login-brand-icon">
            <Leaf size={28} />
          </span>

          <span>
            AgriTerrain <strong>AI</strong>
          </span>
        </Link>

        <div
          className={`auth-status-icon auth-status-${status}`}
          aria-hidden="true"
        >
          {status === 'checking' && (
            <LoaderCircle className="auth-spinner" size={42} />
          )}

          {status === 'success' && <CheckCircle2 size={42} />}

          {status === 'error' && <XCircle size={42} />}
        </div>

        <span className="modal-label">Account verification</span>

        <h1>
          {status === 'checking' && 'Confirming your email'}
          {status === 'success' && 'Email confirmed'}
          {status === 'error' && 'Confirmation failed'}
        </h1>

        <p>{message}</p>

        {status === 'success' && (
          <Link className="submit-login auth-action-link" to="/dashboard">
            Continue to Dashboard
          </Link>
        )}

        {status === 'error' && (
          <Link className="submit-login auth-action-link" to="/signup">
            Return to Sign Up
          </Link>
        )}

        <div className="auth-security-note">
          <ShieldCheck size={18} />
          Authentication is securely managed by Supabase.
        </div>
      </section>
    </main>
  )
}

export default AuthCallback