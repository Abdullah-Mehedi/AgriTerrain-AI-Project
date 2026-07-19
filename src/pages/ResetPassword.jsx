import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  Leaf,
  Lock,
  ShieldCheck,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import './Login.css'

function ResetPassword() {
  const [formData, setFormData] = useState({
    password: '',
    confirmPassword: '',
  })

  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [recoveryReady, setRecoveryReady] = useState(false)
  const [checkingRecovery, setCheckingRecovery] = useState(true)
  const [errors, setErrors] = useState({})
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('')
  const [loading, setLoading] = useState(false)
  const [passwordUpdated, setPasswordUpdated] = useState(false)

  useEffect(() => {
    let componentActive = true

    async function checkRecoverySession() {
      const { data } = await supabase.auth.getSession()

      if (componentActive) {
        setRecoveryReady(Boolean(data.session))
        setCheckingRecovery(false)
      }
    }

    checkRecoverySession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (
        componentActive &&
        (event === 'PASSWORD_RECOVERY' || Boolean(session))
      ) {
        setRecoveryReady(true)
        setCheckingRecovery(false)
      }
    })

    return () => {
      componentActive = false
      subscription.unsubscribe()
    }
  }, [])

  function handleChange(event) {
    const { name, value } = event.target

    setFormData((currentData) => ({
      ...currentData,
      [name]: value,
    }))

    setErrors((currentErrors) => ({
      ...currentErrors,
      [name]: '',
    }))

    setMessage('')
    setMessageType('')
  }

  function validateForm() {
    const newErrors = {}

    if (!formData.password) {
      newErrors.password = 'New password is required.'
    } else if (formData.password.length < 8) {
      newErrors.password = 'Password must contain at least 8 characters.'
    } else if (!/[A-Z]/.test(formData.password)) {
      newErrors.password = 'Include at least one uppercase letter.'
    } else if (!/[a-z]/.test(formData.password)) {
      newErrors.password = 'Include at least one lowercase letter.'
    } else if (!/[0-9]/.test(formData.password)) {
      newErrors.password = 'Include at least one number.'
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'Confirm your new password.'
    } else if (formData.confirmPassword !== formData.password) {
      newErrors.confirmPassword = 'The passwords do not match.'
    }

    return newErrors
  }

  async function handleSubmit(event) {
    event.preventDefault()

    const validationErrors = validateForm()
    setErrors(validationErrors)
    setMessage('')
    setMessageType('')

    if (Object.keys(validationErrors).length > 0) {
      return
    }

    if (!recoveryReady) {
      setMessage(
        'This recovery link is invalid or has expired. Request a new password-reset email.',
      )
      setMessageType('error')
      return
    }

    try {
      setLoading(true)

      const { error } = await supabase.auth.updateUser({
        password: formData.password,
      })

      if (error) {
        throw error
      }

      await supabase.auth.signOut()

      setPasswordUpdated(true)
      setMessage(
        'Your password was updated successfully. You can now sign in with the new password.',
      )
      setMessageType('success')

      setFormData({
        password: '',
        confirmPassword: '',
      })
    } catch (error) {
      setMessage(
        error.message || 'Unable to update the password. Please try again.',
      )
      setMessageType('error')
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
            <span className="login-tag">Secure password update</span>

            <h1>Create a new password for your AgriTerrain account.</h1>

            <p>
              Choose a strong password that you do not use for another
              website or service.
            </p>

            <div className="login-benefit">
              <ShieldCheck size={25} />

              <div>
                <strong>Protected recovery session</strong>
                <span>
                  Your password can only be changed after opening a valid
                  recovery link from your email.
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
            <span>Account security</span>
            <h2>Set a new password</h2>
            <p>Enter and confirm your new account password.</p>
          </div>

          {checkingRecovery ? (
            <div className="login-message" role="status">
              Checking your password-recovery link...
            </div>
          ) : (
            <form className="login-form" onSubmit={handleSubmit} noValidate>
              <div className="login-field">
                <label htmlFor="newPassword">New password</label>

                <div
                  className={`login-input ${
                    errors.password ? 'input-error' : ''
                  }`}
                >
                  <Lock size={19} />

                  <input
                    id="newPassword"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter a strong new password"
                    autoComplete="new-password"
                    value={formData.password}
                    onChange={handleChange}
                    disabled={passwordUpdated}
                    aria-invalid={Boolean(errors.password)}
                  />

                  <button
                    className="password-button"
                    type="button"
                    aria-label={
                      showPassword ? 'Hide password' : 'Show password'
                    }
                    onClick={() =>
                      setShowPassword((currentValue) => !currentValue)
                    }
                    disabled={passwordUpdated}
                  >
                    {showPassword ? (
                      <EyeOff size={19} />
                    ) : (
                      <Eye size={19} />
                    )}
                  </button>
                </div>

                {errors.password && (
                  <small className="field-error">{errors.password}</small>
                )}
              </div>

              <div className="login-field">
                <label htmlFor="confirmNewPassword">
                  Confirm new password
                </label>

                <div
                  className={`login-input ${
                    errors.confirmPassword ? 'input-error' : ''
                  }`}
                >
                  <Lock size={19} />

                  <input
                    id="confirmNewPassword"
                    name="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    placeholder="Enter the new password again"
                    autoComplete="new-password"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    disabled={passwordUpdated}
                    aria-invalid={Boolean(errors.confirmPassword)}
                  />

                  <button
                    className="password-button"
                    type="button"
                    aria-label={
                      showConfirmPassword
                        ? 'Hide confirmed password'
                        : 'Show confirmed password'
                    }
                    onClick={() =>
                      setShowConfirmPassword(
                        (currentValue) => !currentValue,
                      )
                    }
                    disabled={passwordUpdated}
                  >
                    {showConfirmPassword ? (
                      <EyeOff size={19} />
                    ) : (
                      <Eye size={19} />
                    )}
                  </button>
                </div>

                {errors.confirmPassword && (
                  <small className="field-error">
                    {errors.confirmPassword}
                  </small>
                )}
              </div>

              {!passwordUpdated && (
                <button
                  className="submit-login"
                  type="submit"
                  disabled={loading || !recoveryReady}
                >
                  <KeyRound size={18} />
                  {loading ? 'Updating password...' : 'Update Password'}
                </button>
              )}

              {message && (
                <div
                  className={`login-message ${
                    messageType === 'error'
                      ? 'login-message-error'
                      : ''
                  }`}
                  role={messageType === 'error' ? 'alert' : 'status'}
                >
                  {message}
                </div>
              )}

              {!recoveryReady && !passwordUpdated && (
                <p className="create-account">
                  Need another recovery link?

                  <Link to="/forgot-password">Request a new link</Link>
                </p>
              )}

              {passwordUpdated && (
                <Link className="submit-login auth-action-link" to="/login">
                  Sign In
                </Link>
              )}
            </form>
          )}
        </div>
      </section>
    </main>
  )
}

export default ResetPassword