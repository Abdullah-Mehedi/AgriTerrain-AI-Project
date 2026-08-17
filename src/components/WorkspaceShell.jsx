import { useEffect, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import {
  Bell,
  FileText,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  Satellite,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import {
  getProfilePhoto,
  PROFILE_PHOTO_EVENT,
} from '../services/profilePhoto'
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
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profilePhoto, setProfilePhoto] = useState('')
  const [profileNameOverride, setProfileNameOverride] = useState('')

  const fullName =
    profileNameOverride ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'User'


  useEffect(() => {
    const targetUserId =
      String(user?.id || 'anonymous')

    function handleProfileNameChange(event) {
      if (
        String(event.detail?.userId || '') !==
        targetUserId
      ) {
        return
      }

      setProfileNameOverride(
        event.detail?.fullName || '',
      )
    }

    window.addEventListener(
      'agriterrain-profile-name-changed',
      handleProfileNameChange,
    )

    return () => {
      window.removeEventListener(
        'agriterrain-profile-name-changed',
        handleProfileNameChange,
      )
    }
  }, [user?.id])


  useEffect(() => {
    let active = true
    const key = String(user?.id || 'anonymous')

    setProfilePhoto('')

    getProfilePhoto(user?.id).then((photo) => {
      if (active) setProfilePhoto(photo)
    })

    function handleProfilePhotoChange(event) {
      if (String(event.detail?.userId || '') !== key) return
      setProfilePhoto(event.detail?.dataUrl || '')
    }

    window.addEventListener(
      PROFILE_PHOTO_EVENT,
      handleProfilePhotoChange,
    )

    return () => {
      active = false
      window.removeEventListener(
        PROFILE_PHOTO_EVENT,
        handleProfilePhotoChange,
      )
    }
  }, [user?.id])

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
              <Satellite size={23} />
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

        <p className="workspace-menu-label">General</p>

        <nav className="workspace-navigation" aria-label="General navigation">
          <Link to="/" onClick={closeSidebar}>
            <Home size={19} />
            <span>Home Page</span>
          </Link>

          <button
            className="workspace-sidebar-notification"
            type="button"
            aria-expanded={notificationsOpen}
            onClick={() =>
              setNotificationsOpen((current) => !current)
            }
          >
            <Bell size={19} />
            <span>Notifications</span>
          </button>
        </nav>

        {notificationsOpen && (
          <div className="workspace-notification-panel">
            <strong>Notifications</strong>
            <p>No saved notifications yet.</p>
            <small>
              Account and workspace notices can appear here.
            </small>
          </div>
        )}

        <p className="workspace-menu-label workspace-menu-label-secondary">
          Workspace
        </p>

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

        <div className="workspace-sidebar-footer">
          <div className="workspace-account">
            <span className="workspace-avatar" aria-hidden="true">
              {profilePhoto ? (
                <img src={profilePhoto} alt="" />
              ) : (
                <UserRound size={20} />
              )}
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
