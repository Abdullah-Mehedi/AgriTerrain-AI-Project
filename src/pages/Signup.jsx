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
  UserRound,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import './Login.css'

function Signup() {
  const navigate = useNavigate()

  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    acceptTerms: false,
  })

  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
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

    if (!formData.fullName.trim()) {
      newErrors.fullName = 'Full name is required.'
    } else if (formData.fullName.trim().length < 2) {
      newErrors.fullName = 'Enter at least 2 characters.'
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Email address is required.'
    } else if (!/\S+@\S+\.\S+/.test(formData.email)) {
      newErrors.email = 'Enter a valid email address.'
    }

    if (!formData.password) {
      newErrors.password = 'Password is required.'
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
      newErrors.confirmPassword = 'Confirm your password.'
    } else if (formData.confirmPassword !== formData.password) {
      newErrors.confirmPassword = 'The passwords do not match.'
    }

    if (!formData.acceptTerms) {
      newErrors.acceptTerms = 'You must accept the terms to continue.'
    }

    return newErrors
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

      const email = formData.email.trim()
      const password = formData.password

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: formData.fullName.trim(),
          },
          emailRedirectTo: `${window.location.origin}/email-confirmed`,
        },
      })

      if (error) {
        throw error
      }

      if (
        data.user &&
        Array.isArray(data.user.identities) &&
        data.user.identities.length === 0
      ) {
        throw new Error(
          'An account may already exist with this email. Try signing in or resetting the password.',
        )
      }

      if (data.session) {
        navigate('/dashboard', { replace: true })
        return
      }

      navigate('/verify-email', {
        replace: true,
        state: {
          email,
          password,
        },
      })
    } catch (error) {
      setMessage(
        error.message || 'Account creation failed. Please try again.',
      )
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
            <span className="login-tag">Create your account</span>

            <h1>
              Start exploring agricultural land through digital analysis.
            </h1>

            <p>
              Register to access satellite observations, analysis history,
              saved reports and agricultural information.
            </p>

            <div className="login-benefit">
              <ShieldCheck size={25} />

              <div>
                <strong>Email-verified registration</strong>
                <span>
                  After registration, this device will wait for your email
                  confirmation and open the Dashboard automatically.
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
            <span>New account</span>
            <h2>Create your account</h2>
            <p>Complete the information below to register.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit} noValidate>
            <div className="login-field">
              <label htmlFor="fullName">Full name</label>

              <div
                className={`login-input ${
                  errors.fullName ? 'input-error' : ''
                }`}
              >
                <UserRound size={19} />

                <input
                  id="fullName"
                  name="fullName"
                  type="text"
                  placeholder="Enter your full name"
                  autoComplete="name"
                  value={formData.fullName}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.fullName)}
                />
              </div>

              {errors.fullName && (
                <small className="field-error">{errors.fullName}</small>
              )}
            </div>

            <div className="login-field">
              <label htmlFor="signupEmail">Email address</label>

              <div
                className={`login-input ${
                  errors.email ? 'input-error' : ''
                }`}
              >
                <Mail size={19} />

                <input
                  id="signupEmail"
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
              <label htmlFor="signupPassword">Password</label>

              <div
                className={`login-input ${
                  errors.password ? 'input-error' : ''
                }`}
              >
                <Lock size={19} />

                <input
                  id="signupPassword"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Create a strong password"
                  autoComplete="new-password"
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

            <div className="login-field">
              <label htmlFor="confirmPassword">Confirm password</label>

              <div
                className={`login-input ${
                  errors.confirmPassword ? 'input-error' : ''
                }`}
              >
                <Lock size={19} />

                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder="Enter the password again"
                  autoComplete="new-password"
                  value={formData.confirmPassword}
                  onChange={handleChange}
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

            <div className="login-field">
              <label className="remember-option">
                <input
                  name="acceptTerms"
                  type="checkbox"
                  checked={formData.acceptTerms}
                  onChange={handleChange}
                />
                I agree to the Terms of Use and Privacy Policy.
              </label>

              {errors.acceptTerms && (
                <small className="field-error">
                  {errors.acceptTerms}
                </small>
              )}
            </div>

            <button
              className="submit-login"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Creating account...' : 'Create Account'}
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
            Already have an account?

            <Link to="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  )
}

export default Signup