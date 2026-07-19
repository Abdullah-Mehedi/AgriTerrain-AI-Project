import { LoaderCircle } from 'lucide-react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/auth-context'

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <main className="auth-route-loading">
        <LoaderCircle className="auth-spinner" size={42} />
        <p>Checking your account...</p>
      </main>
    )
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    )
  }

  return children
}

export default ProtectedRoute