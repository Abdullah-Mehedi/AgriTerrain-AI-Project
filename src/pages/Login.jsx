import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Leaf,
  Lock,
  Mail,
  ShieldCheck,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import './Login.css'

function Login() {
  const navigate = useNavigate()

  const [formData, setFormData] = useState({
    email: '',
    password: '',
    remember: false,
  })

  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState({})
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  function handleChange(event) {
    const { name, value, type, checked } = event.target

    setFormData((currentData) => ({
      ...currentData,
      [name]: type === 'checkbox' ? checked : value,
    }))

    setErrors((currentErrors) => ({
      ...currentErrors,
      [name]: '',
    }))

    setMessage('')
  }

  function validateForm() {
    const newErrors = {}

    if (!formData.email.trim()) {
      newErrors.email = 'Email address is required.'
    } else if (!/\S+@\S+\.\S+/.test(formData.email)) {
      newErrors.email = 'Enter a valid email address.'
    }

    if (!formData.password) {
      newErrors.password = 'Password is required.'
    }

    return newErrors
  }

  function getLoginErrorMessage(error) {
    const errorMessage = error.message.toLowerCase()

    if (errorMessage.includes('invalid login credentials')) {
      return 'Incorrect email address or password.'
    }

    if (errorMessage.includes('email not confirmed')) {
      return 'Confirm your email from your inbox before signing in.'
    }

    if (errorMessage.includes('too many requests')) {
      return 'Too many login attempts. Please wait and try again.'
    }

    return error.message || 'Login failed. Please try again.'
  }

  async function handleSubmit(event) {
    event.preventDefault()

    const validationErrors = validateForm()
    setErrors(validationErrors)
    setMessage('')

    if (Object.keys(validationErrors).length > 0) {
      return
    }

    try {
      setLoading(true)

      localStorage.setItem(
        'agriterrain_remember_session',
        String(formData.remember),
      )

      const { error } = await supabase.auth.signInWithPassword({
        email: formData.email.trim(),
        password: formData.password,
      })

      if (error) {
        throw error
      }

      navigate('/dashboard', { replace: true })
    } catch (error) {
      setMessage(getLoginErrorMessage(error))
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
            <span className="login-tag">Satellite Intelligence Platform</span>

            <h1>
              Understand agricultural land with reliable digital analysis.
            </h1>

            <p>
              Access land analysis results, satellite observations, saved
              reports and agricultural insights from one secure dashboard.
            </p>

            <div className="login-benefit">
              <ShieldCheck size={25} />

              <div>
                <strong>Secure project access</strong>
                <span>
                  Your session and account information are managed securely
                  through Supabase Authentication.
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
          <Link className="back-home" to="/">
            <ArrowLeft size={18} />
            Back to Home
          </Link>

          <div className="login-heading">
            <span>Welcome back</span>
            <h2>Sign in to your account</h2>
            <p>Enter your verified account information to continue.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit} noValidate>
            <div className="login-field">
              <label htmlFor="email">Email address</label>

              <div
                className={`login-input ${
                  errors.email ? 'input-error' : ''
                }`}
              >
                <Mail size={19} />

                <input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="name@example.com"
                  autoComplete="email"
                  value={formData.email}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.email)}
                />
              </div>

              {errors.email && (
                <small className="field-error">{errors.email}</small>
              )}
            </div>

            <div className="login-field">
              <label htmlFor="password">Password</label>

              <div
                className={`login-input ${
                  errors.password ? 'input-error' : ''
                }`}
              >
                <Lock size={19} />

                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.password)}
                />

                <button
                  className="password-button"
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() =>
                    setShowPassword((currentValue) => !currentValue)
                  }
                >
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>

              {errors.password && (
                <small className="field-error">{errors.password}</small>
              )}
            </div>

            <div className="login-options">
              <label className="remember-option">
                <input
                  name="remember"
                  type="checkbox"
                  checked={formData.remember}
                  onChange={handleChange}
                />
                Remember me
              </label>

              <Link className="forgot-password" to="/forgot-password">
                Forgot password?
              </Link>
            </div>

            <button
              className="submit-login"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>

            {message && (
              <div
                className="login-message login-message-error"
                role="alert"
              >
                {message}
              </div>
            )}
          </form>

          <p className="create-account">
            Don&apos;t have an account?

            <Link to="/signup">Create account</Link>
          </p>

          <p className="demo-notice">
            Email confirmation is required before the first login.
          </p>
        </div>
      </section>
    </main>
  )
}

export default Login