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

function EmailConfirmed() {
  const [status, setStatus] = useState('checking')
  const [message, setMessage] = useState(
    'Confirming your email address...',
  )

  useEffect(() => {
    let componentActive = true
    let confirmationTimer

    function showSuccess(session) {
      if (!componentActive || !session?.user) {
        return
      }

      setStatus('success')
      setMessage(
        'Your email has been verified. You may close this page and return to the device where you created the account.',
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
        showSuccess(data.session)
        return
      }

      confirmationTimer = window.setTimeout(() => {
        if (componentActive) {
          setStatus('error')
          setMessage(
            'The confirmation link is invalid or has expired. Return to the original device and request another email.',
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
        showSuccess(session)
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

        <span className="modal-label">Email verification</span>

        <h1>
          {status === 'checking' && 'Verifying your email'}
          {status === 'success' && 'Email verified'}
          {status === 'error' && 'Verification failed'}
        </h1>

        <p>{message}</p>

        {status === 'success' && (
          <div className="login-message" role="status">
            The original signup page will detect this confirmation
            automatically and open the Dashboard.
          </div>
        )}

        {status === 'error' && (
          <Link className="submit-login auth-action-link" to="/signup">
            Return to Sign Up
          </Link>
        )}

        <div className="auth-security-note">
          <ShieldCheck size={18} />
          You can safely close this page after verification.
        </div>
      </section>
    </main>
  )
}

export default EmailConfirmed