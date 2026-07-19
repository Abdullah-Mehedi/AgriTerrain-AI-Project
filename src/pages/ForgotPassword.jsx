import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  KeyRound,
  Leaf,
  Mail,
  ShieldCheck,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import './Login.css'

function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setErrorMessage('')
    setSuccessMessage('')

    if (!email.trim()) {
      setErrorMessage('Email address is required.')
      return
    }

    if (!/\S+@\S+\.\S+/.test(email)) {
      setErrorMessage('Enter a valid email address.')
      return
    }

    try {
      setLoading(true)

      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        {
          redirectTo: `${window.location.origin}/reset-password`,
        },
      )

      if (error) {
        throw error
      }

      setSuccessMessage(
        'If an account exists for this email, a password-reset link has been sent. Check your inbox and spam folder.',
      )
    } catch (error) {
      setErrorMessage(
        error.message || 'Unable to send the reset email. Please try again.',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-information">
        <div className="login-information-content">
          <Link className="login-brand" to="/">
            <span className="login-brand-icon">
              <Leaf size={28} />
            </span>

            <span>
              AgriTerrain <strong>AI</strong>
            </span>
          </Link>

          <div className="login-introduction">
            <span className="login-tag">Account recovery</span>

            <h1>Recover access to your agricultural analysis account.</h1>

            <p>
              Enter your registered email address and we will send a secure
              password-reset link to your inbox.
            </p>

            <div className="login-benefit">
              <ShieldCheck size={25} />

              <div>
                <strong>Secure password recovery</strong>
                <span>
                  Password changes require a temporary recovery link sent
                  directly to the account owner.
                </span>
              </div>
            </div>
          </div>

          <p className="login-copyright">
            © 2026 AgriTerrain AI. Academic project demonstration.
          </p>
        </div>
      </section>

      <section className="login-form-section">
        <div className="login-form-container">
          <Link className="back-home" to="/login">
            <ArrowLeft size={18} />
            Back to Login
          </Link>

          <div className="login-heading">
            <span>Password recovery</span>
            <h2>Forgot your password?</h2>
            <p>Enter the email address connected to your account.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit} noValidate>
            <div className="login-field">
              <label htmlFor="recoveryEmail">Email address</label>

              <div
                className={`login-input ${
                  errorMessage ? 'input-error' : ''
                }`}
              >
                <Mail size={19} />

                <input
                  id="recoveryEmail"
                  type="email"
                  placeholder="name@example.com"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setErrorMessage('')
                    setSuccessMessage('')
                  }}
                  aria-invalid={Boolean(errorMessage)}
                />
              </div>

              {errorMessage && (
                <small className="field-error">{errorMessage}</small>
              )}
            </div>

            <button
              className="submit-login"
              type="submit"
              disabled={loading}
            >
              <KeyRound size={18} />
              {loading ? 'Sending reset link...' : 'Send Reset Link'}
            </button>

            {successMessage && (
              <div className="login-message" role="status">
                {successMessage}
              </div>
            )}
          </form>

          <p className="create-account">
            Remembered your password?

            <Link to="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  )
}

export default ForgotPassword