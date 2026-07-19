import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Activity,
  Clock3,
  Droplets,
  FileText,
  Home,
  LayoutDashboard,
  Leaf,
  LogOut,
  Map,
  Satellite,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import './Dashboard.css'

function Dashboard() {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  const fullName =
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'User'

  async function handleLogout() {
    try {
      setLoggingOut(true)
      setLogoutError('')
      await signOut()
      navigate('/login', { replace: true })
    } catch (error) {
      setLogoutError(error.message || 'Unable to sign out.')
      setLoggingOut(false)
    }
  }

  return (
    <main className="dashboard-page">
      <aside className="dashboard-sidebar">
        <Link className="dashboard-brand" to="/">
          <span>
            <Leaf size={24} />
          </span>

          <strong>
            AgriTerrain <b>AI</b>
          </strong>
        </Link>

        <nav className="dashboard-navigation" aria-label="Dashboard navigation">
          <Link className="active" to="/dashboard">
            <LayoutDashboard size={19} />
            Dashboard
          </Link>

          <button type="button" disabled>
            <Satellite size={19} />
            Satellite Analysis
            <small>Soon</small>
          </button>

          <button type="button" disabled>
            <FileText size={19} />
            Reports
            <small>Soon</small>
          </button>

          <Link to="/">
            <Home size={19} />
            Home Page
          </Link>
        </nav>

        <div className="dashboard-account">
          <div className="dashboard-avatar">
            <UserRound size={21} />
          </div>

          <div>
            <strong>{fullName}</strong>
            <span>{user?.email}</span>
          </div>
        </div>

        <button
          className="dashboard-logout"
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
        >
          <LogOut size={18} />
          {loggingOut ? 'Signing out...' : 'Sign Out'}
        </button>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <span>Authenticated workspace</span>
            <h1>Welcome, {fullName}</h1>
            <p>
              Review your agricultural analysis workspace and account status.
            </p>
          </div>

          <div className="verified-badge">
            <ShieldCheck size={18} />
            Email verified
          </div>
        </header>

        {logoutError && (
          <div className="dashboard-error" role="alert">
            {logoutError}
          </div>
        )}

        <section className="dashboard-stat-grid">
          <article className="dashboard-stat">
            <div className="stat-icon stat-green">
              <Map size={23} />
            </div>

            <div>
              <span>Analyzed fields</span>
              <strong>18</strong>
              <small>Demonstration data</small>
            </div>
          </article>

          <article className="dashboard-stat">
            <div className="stat-icon stat-blue">
              <Droplets size={23} />
            </div>

            <div>
              <span>Detected ponds</span>
              <strong>04</strong>
              <small>Demonstration data</small>
            </div>
          </article>

          <article className="dashboard-stat">
            <div className="stat-icon stat-orange">
              <Home size={23} />
            </div>

            <div>
              <span>Settlement units</span>
              <strong>27</strong>
              <small>Demonstration data</small>
            </div>
          </article>

          <article className="dashboard-stat">
            <div className="stat-icon stat-lime">
              <Activity size={23} />
            </div>

            <div>
              <span>Crop health score</span>
              <strong>82%</strong>
              <small>Demonstration data</small>
            </div>
          </article>
        </section>

        <section className="dashboard-content-grid">
          <article className="dashboard-panel">
            <div className="dashboard-panel-heading">
              <div>
                <span>Analysis overview</span>
                <h2>Land distribution</h2>
              </div>

              <Satellite size={22} />
            </div>

            <div className="distribution-list">
              <div>
                <div className="distribution-label">
                  <span>Agricultural land</span>
                  <strong>62%</strong>
                </div>

                <div className="distribution-track">
                  <span style={{ width: '62%' }} />
                </div>
              </div>

              <div>
                <div className="distribution-label">
                  <span>Waterbody</span>
                  <strong>14%</strong>
                </div>

                <div className="distribution-track water-track">
                  <span style={{ width: '14%' }} />
                </div>
              </div>

              <div>
                <div className="distribution-label">
                  <span>Settlement</span>
                  <strong>24%</strong>
                </div>

                <div className="distribution-track settlement-track">
                  <span style={{ width: '24%' }} />
                </div>
              </div>
            </div>

            <p className="dashboard-data-note">
              These values are sample frontend data. Real satellite analysis
              will replace them during the AI integration phase.
            </p>
          </article>

          <article className="dashboard-panel">
            <div className="dashboard-panel-heading">
              <div>
                <span>Account information</span>
                <h2>Your secure profile</h2>
              </div>

              <UserRound size={22} />
            </div>

            <div className="account-details">
              <div>
                <span>Full name</span>
                <strong>{fullName}</strong>
              </div>

              <div>
                <span>Email address</span>
                <strong>{user?.email}</strong>
              </div>

              <div>
                <span>Account ID</span>
                <strong className="account-id">{user?.id}</strong>
              </div>

              <div>
                <span>Last sign in</span>
                <strong>
                  {user?.last_sign_in_at
                    ? new Date(user.last_sign_in_at).toLocaleString()
                    : 'First session'}
                </strong>
              </div>
            </div>
          </article>

          <article className="dashboard-panel dashboard-activity-panel">
            <div className="dashboard-panel-heading">
              <div>
                <span>Recent activity</span>
                <h2>Analysis history</h2>
              </div>

              <Clock3 size={22} />
            </div>

            <div className="empty-activity">
              <span>
                <Satellite size={30} />
              </span>

              <h3>No completed analyses yet</h3>
              <p>
                Your satellite-analysis history will appear here after the
                analysis module is connected.
              </p>
            </div>
          </article>
        </section>
      </section>
    </main>
  )
}

export default Dashboard