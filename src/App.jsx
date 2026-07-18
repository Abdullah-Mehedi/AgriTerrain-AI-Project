import { useState } from 'react'
import {
  Menu,
  X,
  Sprout,
  UserRound,
  Map,
  Satellite,
  Leaf,
  Bot,
  History,
  Lightbulb,
  FileText,
  ScanLine,
  CloudSun,
  GraduationCap,
  Tractor,
  Building2,
  ShieldCheck,
  SearchCheck,
  LockKeyhole,
  BarChart3,
} from 'lucide-react'

const capabilities = [
  {
    icon: Map,
    title: 'Interactive Map',
    description: 'Search and explore locations from division to village.',
  },
  {
    icon: Satellite,
    title: 'Satellite Imagery',
    description: 'View agricultural areas using open satellite information.',
  },
  {
    icon: Leaf,
    title: 'Crop Health Score',
    description: 'Understand vegetation health and possible crop stress.',
  },
  {
    icon: Bot,
    title: 'AI Assistant',
    description: 'Receive simple guidance for using the analysis tools.',
  },
  {
    icon: History,
    title: 'Historical Compare',
    description: 'Compare agricultural information by date and location.',
  },
  {
    icon: Lightbulb,
    title: 'Recommendations',
    description: 'Get crop-care, irrigation, and risk-awareness suggestions.',
  },
  {
    icon: FileText,
    title: 'PDF Report Generation',
    description: 'Generate downloadable reports from analysis results.',
  },
  {
    icon: ScanLine,
    title: 'Field Detection',
    description: 'Identify crop fields, ponds, and settlement areas.',
  },
  {
    icon: CloudSun,
    title: 'Weather Updates',
    description: 'Review temperature, rainfall, and humidity information.',
  },
]

const userGroups = [
  {
    icon: GraduationCap,
    title: 'Students & Researchers',
    description:
      'Explore satellite information and study agricultural land-use patterns.',
  },
  {
    icon: Tractor,
    title: 'Farmers',
    description:
      'Understand field conditions and receive practical farming guidance.',
  },
  {
    icon: Building2,
    title: 'Agricultural Officers',
    description:
      'Review local agricultural, waterbody, settlement, and weather data.',
  },
]

function App() {
  const [menuOpen, setMenuOpen] = useState(false)

  function showComingSoon(feature) {
    alert(`${feature} will be developed in the next project phase.`)
    setMenuOpen(false)
  }

  return (
    <>
      <header className="navbar">
        <div className="container nav-container">
          <a href="#home" className="logo">
            <span className="logo-icon">
              <Sprout size={23} />
            </span>

            <span>
              AgriTerrain <strong>AI</strong>
            </span>
          </a>

          <nav className={menuOpen ? 'nav-links open' : 'nav-links'}>
            <a href="#home" onClick={() => setMenuOpen(false)}>
              Home
            </a>

            <button onClick={() => showComingSoon('Dashboard')}>
              Dashboard
            </button>

            <button onClick={() => showComingSoon('Satellite Analysis')}>
              Satellite Analysis
            </button>

            <button onClick={() => showComingSoon('Reports')}>
              Reports
            </button>

            <button
              className="login-button mobile-login"
              onClick={() => showComingSoon('Login')}
            >
              <UserRound size={17} />
              Login
            </button>
          </nav>

          <button
            className="login-button desktop-login"
            onClick={() => showComingSoon('Login')}
          >
            <UserRound size={17} />
            Login
          </button>

          <button
            className="menu-button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Open navigation menu"
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
      </header>

      <main id="home">
        <section className="hero">
          <div className="container hero-content">
            <div className="hero-text">
              <span className="hero-label">
                AI-powered agricultural land analysis
              </span>

              <h1>
                Analyze Land.
                <br />
                Detect Fields.
                <br />
                <strong>Generate Reports.</strong>
              </h1>

              <p>
                Explore locations, view satellite imagery, and understand
                agricultural land, waterbodies, and settlements through one
                visual platform.
              </p>

              <div className="hero-buttons">
                <button onClick={() => showComingSoon('Satellite Analysis')}>
                  <Map size={19} />
                  View Satellite Map
                </button>

                <button
                  className="outline-button"
                  onClick={() => showComingSoon('Dashboard')}
                >
                  <BarChart3 size={19} />
                  Open Dashboard
                </button>
              </div>
            </div>

            <div className="analysis-box">
              <div className="analysis-heading">
                <span>Analysis Preview</span>
                <Satellite size={20} />
              </div>

              <div className="analysis-map">
                <ScanLine size={60} />
                <p>Selected Area</p>
              </div>

              <div className="analysis-results">
                <div>
                  <strong>18</strong>
                  <span>Fields</span>
                </div>

                <div>
                  <strong>04</strong>
                  <span>Ponds</span>
                </div>

                <div>
                  <strong>27</strong>
                  <span>Houses</span>
                </div>

                <div>
                  <strong>82%</strong>
                  <span>Health</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section capabilities" id="capabilities">
          <div className="container">
            <div className="section-heading">
              <span>Platform capabilities</span>
              <h2>Understand agricultural locations more easily</h2>
              <p>
                AgriTerrain AI combines important agricultural and
                environmental tools in one simple interface.
              </p>
            </div>

            <div className="capability-grid">
              {capabilities.map((capability) => {
                const Icon = capability.icon

                return (
                  <article className="capability-card" key={capability.title}>
                    <div className="card-icon">
                      <Icon size={25} />
                    </div>

                    <h3>{capability.title}</h3>
                    <p>{capability.description}</p>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        <section className="section user-section">
          <div className="container">
            <div className="section-heading">
              <span>Designed for users</span>
              <h2>One platform for different users</h2>
            </div>

            <div className="user-grid">
              {userGroups.map((group) => {
                const Icon = group.icon

                return (
                  <article className="user-card" key={group.title}>
                    <div className="user-icon">
                      <Icon size={42} />
                    </div>

                    <h3>{group.title}</h3>
                    <p>{group.description}</p>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        <section className="trust-section">
          <div className="container trust-grid">
            <div>
              <ShieldCheck />
              <span>
                <strong>Free and Reliable</strong>
                Open-source project tools
              </span>
            </div>

            <div>
              <ScanLine />
              <span>
                <strong>Visual Detection</strong>
                Selected-area analysis
              </span>
            </div>

            <div>
              <SearchCheck />
              <span>
                <strong>Source Focused</strong>
                Verifiable information
              </span>
            </div>

            <div>
              <LockKeyhole />
              <span>
                <strong>Secure by Design</strong>
                Privacy-aware structure
              </span>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="container footer-content">
          <div>
            <a href="#home" className="logo footer-logo">
              <span className="logo-icon">
                <Sprout size={23} />
              </span>

              <span>
                AgriTerrain <strong>AI</strong>
              </span>
            </a>

            <p>
              Satellite-Based Agricultural Land, Waterbody, and Settlement
              Analysis System.
            </p>
          </div>

          <div>
            <h3>Project</h3>
            <p>React and Vite</p>
            <p>Open-source tools</p>
            <p>CSE327 demonstration</p>
          </div>
        </div>

        <div className="container copyright">
          © 2026 AgriTerrain AI — CSE327 Demo Project
        </div>
      </footer>
    </>
  )
}

export default App