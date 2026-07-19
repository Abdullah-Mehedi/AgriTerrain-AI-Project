import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Leaf,
  LoaderCircle,
  MailCheck,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import './Login.css'

function VerifyEmail() {
  const location = useLocation()
  const navigate = useNavigate()
  const checkingRef = useRef(false)

  const email = location.state?.email
  const password = location.state?.password

  const [message, setMessage] = useState(
    'Waiting for you to confirm the email sent to your inbox.',
  )
  const [resending, setResending] = useState(false)

  const checkVerification = useCallback(async () => {
    if (!email || !password || checkingRef.current) {
      return
    }

    checkingRef.current = true

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    checkingRef.current = false

    if (data.session) {
      navigate('/dashboard', { replace: true })
      return
    }

    if (
      error &&
      !error.message.toLowerCase().includes('email not confirmed')
    ) {
      setMessage(error.message)
    }
  }, [email, password, navigate])

  useEffect(() => {
    if (!email || !password) {
      return undefined
    }

    const initialCheckTimer = window.setTimeout(
      checkVerification,
      0,
    )

    const verificationInterval = window.setInterval(
      checkVerification,
      4000,
    )

    return () => {
      window.clearTimeout(initialCheckTimer)
      window.clearInterval(verificationInterval)
    }
  }, [email, password, checkVerification])

  async function resendConfirmation() {
    if (!email) {
      return
    }

    try {
      setResending(true)

      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/email-confirmed`,
        },
      })

      if (error) {
        throw error
      }

      setMessage(
        'A new confirmation email was sent. Check your inbox and spam folder.',
      )
    } catch (error) {
      setMessage(error.message || 'Unable to resend the email.')
    } finally {
      setResending(false)
    }
  }

  if (!email || !password) {
    return (
      <main className="auth-status-page">
        <section className="auth-status-card">
          <div className="auth-status-icon auth-status-error">
            <MailCheck size={42} />
          </div>

          <h1>Verification session unavailable</h1>

          <p>
            Return to Sign Up and create the account again. Do not refresh the
            waiting page while verification is in progress.
          </p>

          <Link className="submit-login auth-action-link" to="/signup">
            Return to Sign Up
          </Link>
        </section>
      </main>
    )
  }

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

        <div className="auth-status-icon auth-status-checking">
          <LoaderCircle className="auth-spinner" size={42} />
        </div>

        <span className="modal-label">Email verification</span>

        <h1>Check your inbox</h1>

        <p>
          We sent a confirmation link to <strong>{email}</strong>. Confirm it
          from any device, then keep this page open.
        </p>

        <div className="login-message" role="status">
          {message}
        </div>

        <button
          className="submit-login verification-button"
          type="button"
          onClick={checkVerification}
        >
          <MailCheck size={18} />
          I Have Confirmed My Email
        </button>

        <button
          className="verification-resend"
          type="button"
          onClick={resendConfirmation}
          disabled={resending}
        >
          <RefreshCw size={16} />
          {resending ? 'Sending...' : 'Resend confirmation email'}
        </button>

        <div className="auth-security-note">
          <ShieldCheck size={18} />
          This page checks verification automatically every four seconds.
        </div>
      </section>
    </main>
  )
}

export default VerifyEmail