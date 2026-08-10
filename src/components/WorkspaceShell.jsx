import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import {
  Bell,
  FileText,
  Home,
  LayoutDashboard,
  Leaf,
  LogOut,
  Menu,
  Satellite,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import './WorkspaceShell.css'

function getInitials(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function WorkspaceShell({ children, title, description, headerActions }) {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  const fullName =
    user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'

  async function handleLogout() {
    try {
      setLoggingOut(true)
      setLogoutError('')
      await signOut()
      navigate('/login', { replace: true })
    } catch (error) {
      setLogoutError(error.message || 'Unable to sign out right now.')
      setLoggingOut(false)
    }
  }

  function closeSidebar() {
    setSidebarOpen(false)
  }

  return (
    <main className={sidebarOpen ? 'workspace-shell sidebar-open' : 'workspace-shell'}>
      <button
        className="workspace-backdrop"
        type="button"
        aria-label="Close navigation"
        onClick={closeSidebar}
      />

      <aside className="workspace-sidebar">
        <div className="workspace-sidebar-heading">
          <Link className="workspace-brand" to="/" onClick={closeSidebar}>
            <span className="workspace-brand-icon">
              <Leaf size={23} />
            </span>
            <span>
              AgriTerrain <strong>AI</strong>
            </span>
          </Link>

          <button
            className="workspace-sidebar-close"
            type="button"
            aria-label="Close navigation"
            onClick={closeSidebar}
          >
            <X size={20} />
          </button>
        </div>

        <p className="workspace-menu-label">Workspace</p>

        <nav className="workspace-navigation" aria-label="Workspace navigation">
          <NavLink
            to="/dashboard"
            className={({ isActive }) => (isActive ? 'active' : '')}
            onClick={closeSidebar}
          >
            <LayoutDashboard size={19} />
            <span>Dashboard</span>
          </NavLink>

          <NavLink
            to="/satellite-analysis"
            className={({ isActive }) => (isActive ? 'active' : '')}
            onClick={closeSidebar}
          >
            <Satellite size={19} />
            <span>Satellite Analysis</span>
          </NavLink>

          <NavLink
            to="/reports"
            className={({ isActive }) => (isActive ? 'active' : '')}
            onClick={closeSidebar}
          >
            <FileText size={19} />
            <span>Reports / History</span>
          </NavLink>
        </nav>

        <p className="workspace-menu-label workspace-menu-label-secondary">
          General
        </p>

        <nav className="workspace-navigation" aria-label="General navigation">
          <Link to="/" onClick={closeSidebar}>
            <Home size={19} />
            <span>Home Page</span>
          </Link>
        </nav>

        <div className="workspace-sidebar-tip">
          <span>
            <Sparkles size={17} />
          </span>
          <div>
            <strong>Analysis tip</strong>
            <p>Draw a focused boundary for faster and clearer AI results.</p>
          </div>
        </div>

        <div className="workspace-sidebar-footer">
          <div className="workspace-account">
            <span className="workspace-avatar" aria-hidden="true">
              {getInitials(fullName) || <UserRound size={20} />}
            </span>
            <div>
              <strong>{fullName}</strong>
              <span title={user?.email}>{user?.email}</span>
            </div>
          </div>

          <button
            className="workspace-logout"
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <LogOut size={18} />
            {loggingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </aside>

      <section className="workspace-main">
        <header className="workspace-header">
          <button
            className="workspace-menu-button"
            type="button"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={22} />
          </button>

          <div className="workspace-page-heading">
            <span>Agricultural intelligence workspace</span>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>

          <div className="workspace-header-actions">
            {headerActions}
            <button className="workspace-notification" type="button" aria-label="Notifications">
              <Bell size={20} />
              <span />
            </button>
            <div className="workspace-verified">
              <ShieldCheck size={18} />
              <span>
                <strong>Verified account</strong>
                <small>Supabase secured</small>
              </span>
            </div>
          </div>
        </header>

        {logoutError && (
          <div className="workspace-error" role="alert">
            {logoutError}
          </div>
        )}

        <div className="workspace-content">{children}</div>
      </section>
    </main>
  )
}

export default WorkspaceShell
