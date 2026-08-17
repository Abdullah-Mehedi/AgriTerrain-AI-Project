import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  Check,
  Clipboard,
  CloudRain,
  CloudSun,
  Droplets,
  FileText,
  History,
  Home,
  ImagePlus,
  Leaf,
  Lightbulb,
  Map,
  MessageCircleQuestion,
  Pencil,
  Satellite,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserRound,
  Waves,
  X,
} from 'lucide-react'
import WorkspaceShell from '../components/WorkspaceShell'
import { useAuth } from '../context/auth-context'
import { supabase } from '../lib/supabase'
import {
  deleteProfilePhoto,
  getProfilePhoto,
  PROFILE_PHOTO_EVENT,
  saveProfilePhoto,
} from '../services/profilePhoto'
import './Dashboard.css'

const fallbackAnalysis = {
  mode: 'empty',
  counts: { crop: 0, water: 0, building: 0 },
  coverage: { crop: 0, water: 0, building: 0 },
  meanModelCertainty: 0,
  location: 'No satellite analysis saved yet',
  createdAt: null,
}

function readStoredData(key) {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}

function numeric(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}


function getInitials(name) {
  return String(name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function normaliseProfileImage(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) {
      reject(new Error('Choose or paste an image file.'))
      return
    }

    const reader = new FileReader()

    reader.onerror = () =>
      reject(new Error('Unable to read this image.'))

    reader.onload = () => {
      const image = new Image()

      image.onerror = () =>
        reject(new Error('Unable to open this image.'))

      image.onload = () => {
        const size = 320
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')

        if (!context) {
          reject(new Error('Image processing is unavailable.'))
          return
        }

        canvas.width = size
        canvas.height = size

        const scale = Math.max(
          size / image.naturalWidth,
          size / image.naturalHeight,
        )

        const width = image.naturalWidth * scale
        const height = image.naturalHeight * scale

        context.drawImage(
          image,
          (size - width) / 2,
          (size - height) / 2,
          width,
          height,
        )

        resolve(canvas.toDataURL('image/jpeg', 0.86))
      }

      image.src = String(reader.result || '')
    }

    reader.readAsDataURL(file)
  })
}

function Dashboard() {
  const { user } = useAuth()
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [profilePhoto, setProfilePhoto] = useState('')
  const [profilePhotoMessage, setProfilePhotoMessage] = useState('')
  const [profilePhotoBusy, setProfilePhotoBusy] = useState(false)

  const accountFullName =
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'User'

  const [profileName, setProfileName] = useState(accountFullName)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(accountFullName)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameMessage, setNameMessage] = useState('')

  const fullName = profileName || accountFullName


  useEffect(() => {
    let active = true
    const key = String(user?.id || 'anonymous')

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

  async function storeProfileFile(file) {
    try {
      setProfilePhotoBusy(true)
      setProfilePhotoMessage('')

      const dataUrl = await normaliseProfileImage(file)

      await saveProfilePhoto(user?.id, dataUrl)

      setProfilePhoto(dataUrl)
      setProfilePhotoMessage('Profile photo updated.')
    } catch (error) {
      setProfilePhotoMessage(
        error.message || 'Unable to save this profile photo.',
      )
    } finally {
      setProfilePhotoBusy(false)
    }
  }

  async function pasteProfilePhoto() {
    if (!navigator.clipboard?.read) {
      setProfilePhotoMessage(
        'Click the profile-photo area and press Ctrl+V to paste an image.',
      )
      return
    }

    try {
      const clipboardItems = await navigator.clipboard.read()

      for (const item of clipboardItems) {
        const imageType = item.types.find((type) =>
          type.startsWith('image/'),
        )

        if (!imageType) continue

        const blob = await item.getType(imageType)
        const file = new File(
          [blob],
          'pasted-profile-photo',
          { type: imageType },
        )

        await storeProfileFile(file)
        return
      }

      setProfilePhotoMessage(
        'No image was found in the clipboard.',
      )
    } catch {
      setProfilePhotoMessage(
        'Clipboard access was not available. Focus this card and press Ctrl+V.',
      )
    }
  }

  function handleProfilePaste(event) {
    const items = [...(event.clipboardData?.items || [])]
    const imageItem = items.find(
      (item) =>
        item.kind === 'file' &&
        item.type.startsWith('image/'),
    )

    const file = imageItem?.getAsFile()

    if (!file) {
      setProfilePhotoMessage(
        'Copy an image first, then press Ctrl+V here.',
      )
      return
    }

    event.preventDefault()
    void storeProfileFile(file)
  }

  async function removeProfileImage() {
    try {
      setProfilePhotoBusy(true)
      await deleteProfilePhoto(user?.id)
      setProfilePhoto('')
      setProfilePhotoMessage('Profile photo removed.')
    } catch {
      setProfilePhotoMessage(
        'Unable to remove the profile photo.',
      )
    } finally {
      setProfilePhotoBusy(false)
    }
  }

  useEffect(() => {
    setProfileName(accountFullName)

    if (!editingName) {
      setNameDraft(accountFullName)
    }
  }, [accountFullName, editingName])

  async function saveProfileName() {
    const nextName = nameDraft.trim()

    if (nextName.length < 2) {
      setNameMessage('Enter a valid full name.')
      return
    }

    try {
      setNameSaving(true)
      setNameMessage('')

      const { data, error } =
        await supabase.auth.updateUser({
          data: {
            ...(user?.user_metadata || {}),
            full_name: nextName,
          },
        })

      if (error) throw error

      const savedName =
        data?.user?.user_metadata?.full_name ||
        nextName

      setProfileName(savedName)
      setNameDraft(savedName)
      setEditingName(false)
      setNameMessage('Name updated.')

      window.dispatchEvent(
        new CustomEvent(
          'agriterrain-profile-name-changed',
          {
            detail: {
              userId: String(user?.id || 'anonymous'),
              fullName: savedName,
            },
          },
        ),
      )
    } catch (error) {
      setNameMessage(
        error?.message ||
        'Unable to update your name.',
      )
    } finally {
      setNameSaving(false)
    }
  }

  const analysis = useMemo(
    () => readStoredData('agriterrain_latest_analysis') || fallbackAnalysis,
    [],
  )
  const weather = useMemo(
    () => readStoredData('agriterrain_latest_weather'),
    [],
  )

  const coverage = {
    crop: numeric(analysis.coverage?.crop ?? analysis.coverage?.agricultural),
    water: numeric(analysis.coverage?.water),
    building: numeric(analysis.coverage?.building ?? analysis.coverage?.built),
  }
  const coverageOther = Math.max(
    0,
    100 - coverage.crop - coverage.water - coverage.building,
  )
  const counts = {
    crop: numeric(analysis.counts?.crop ?? analysis.counts?.fields),
    water: numeric(analysis.counts?.water ?? analysis.counts?.waterbodies),
    building: numeric(analysis.counts?.building ?? analysis.counts?.buildings),
  }
  const hasAnalysis = analysis.mode === 'ml'
  const dataLabel = hasAnalysis ? 'Latest AI result' : 'No result yet'
  const certainty = hasAnalysis
    ? numeric(analysis.meanModelCertainty ?? analysis.confidence)
    : 0

  return (
    <WorkspaceShell
      title={`Welcome back, ${fullName}`}
      description="Monitor saved land analysis, environmental context, and recent activity."
      headerActions={
        <Link className="dashboard-header-cta no-print" to="/satellite-analysis">
          <Satellite size={16} />
          New analysis
        </Link>
      }
    >
      <section className="dashboard-welcome-card">
        <div>
          <span className="dashboard-eyebrow">
            <Sparkles size={14} />
            Your agricultural command centre
          </span>
          <h2>Turn satellite observations into clear, reviewable evidence.</h2>
          <p>
            Search a location, draw a focused boundary, run the land-cover model,
            then keep the result in Reports / History for comparison and PDF reporting.
          </p>
        </div>

        <div className="dashboard-welcome-visual" aria-hidden="true">
          <span className="visual-orbit visual-orbit-large" />
          <span className="visual-orbit visual-orbit-small" />
          <div>
            <Satellite size={48} />
            <small>Earth observation</small>
          </div>
        </div>
      </section>

      <section className="dashboard-stat-grid" aria-label="Latest analysis summary">
        <article className="dashboard-stat-card">
          <span className="dashboard-stat-icon stat-icon-green"><Map size={22} /></span>
          <div><p>Crop regions</p><strong>{counts.crop}</strong><small>{dataLabel}</small></div>
          <span className="dashboard-stat-change">Agriculture</span>
        </article>
        <article className="dashboard-stat-card">
          <span className="dashboard-stat-icon stat-icon-blue"><Droplets size={22} /></span>
          <div><p>Water regions</p><strong>{counts.water}</strong><small>{dataLabel}</small></div>
          <span className="dashboard-stat-change stat-change-blue">Water</span>
        </article>
        <article className="dashboard-stat-card">
          <span className="dashboard-stat-icon stat-icon-orange"><Home size={22} /></span>
          <div><p>Building regions</p><strong>{counts.building}</strong><small>{dataLabel}</small></div>
          <span className="dashboard-stat-change stat-change-orange">Settlement</span>
        </article>
        <article className="dashboard-stat-card">
          <span className="dashboard-stat-icon stat-icon-lime"><Activity size={22} /></span>
          <div><p>Model certainty</p><strong>{hasAnalysis ? `${Math.round(certainty)}%` : '—'}</strong><small>{dataLabel}</small></div>
          <span className="dashboard-stat-change">Model certainty</span>
        </article>
      </section>

      <section className="dashboard-section-heading">
        <div><span>Tools</span><h2>Quick access</h2></div>
        <p>Continue analysis, review saved work, or open the built-in guide.</p>
      </section>

      <section className="dashboard-quick-grid">
        <Link className="dashboard-quick-card quick-card-featured" to="/satellite-analysis">
          <span><Satellite size={23} /></span>
          <div><strong>Satellite analysis</strong><small>Search, draw, and analyze land</small></div>
          <ArrowRight size={17} />
        </Link>
        <Link className="dashboard-quick-card" to="/reports">
          <span><FileText size={23} /></span>
          <div><strong>Reports / History</strong><small>Review and export saved analyses</small></div>
          <ArrowRight size={17} />
        </Link>
        <button className="dashboard-quick-card" type="button" onClick={() => setAssistantOpen(true)}>
          <span><Bot size={23} /></span>
          <div><strong>AI guide</strong><small>Learn how to use the analysis</small></div>
          <ArrowRight size={17} />
        </button>
        <Link className="dashboard-quick-card" to="/recommendations">
          <span><Lightbulb size={23} /></span>
          <div><strong>Recommendations</strong><small>Review evidence-based guidance</small></div>
          <ArrowRight size={17} />
        </Link>
      </section>

      <section className="dashboard-main-grid">
        <article className="dashboard-panel dashboard-land-panel">
          <div className="dashboard-panel-heading">
            <div>
              <span>Latest analysis</span>
              <h2>Land-cover distribution</h2>
              <p>{analysis.location || fallbackAnalysis.location}</p>
            </div>
            <Link to="/satellite-analysis">Open map <ArrowRight size={15} /></Link>
          </div>

          <div className="dashboard-distribution">
            <div
              className="dashboard-donut"
              style={{
                background: `conic-gradient(#188b50 0 ${coverage.crop}%, #36a9d6 ${coverage.crop}% ${coverage.crop + coverage.water}%, #e69a45 ${coverage.crop + coverage.water}% ${coverage.crop + coverage.water + coverage.building}%, #d7dfd8 0)`,
              }}
            >
              <div><strong>{hasAnalysis ? `${coverage.crop.toFixed(1)}%` : '—'}</strong><span>Crop cover</span></div>
            </div>

            <div className="dashboard-legend">
              {[
                ['Crop-labelled cover', coverage.crop, 'legend-agriculture'],
                ['Water-labelled cover', coverage.water, 'legend-water'],
                ['Building-labelled cover', coverage.building, 'legend-built'],
                ['Other model classes', coverageOther, 'legend-barren'],
              ].map(([label, value, className]) => (
                <div key={label}>
                  <span className={className} />
                  <p>{label}</p>
                  <strong>{hasAnalysis ? `${Number(value).toFixed(1)}%` : '—'}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="dashboard-source-note">
            <Satellite size={15} />
            {hasAnalysis
              ? 'Generated from the latest saved land-cover model result.'
              : 'No demonstration values are inserted. Run Satellite Analysis to populate this panel.'}
          </div>
        </article>

        <article className="dashboard-panel dashboard-condition-panel">
          <div className="dashboard-panel-heading">
            <div><span>Environment</span><h2>Current field context</h2><p>{weather?.location || 'No weather location saved'}</p></div>
            <CloudSun size={22} />
          </div>
          <div className="dashboard-condition-grid">
            <div><span className="condition-icon weather"><CloudSun size={20} /></span><p>Temperature</p><strong>{weather?.temperature != null ? `${Math.round(weather.temperature)}°C` : '—'}</strong><small>{weather ? 'Open-Meteo context' : 'Unavailable'}</small></div>
            <div><span className="condition-icon rain"><CloudRain size={20} /></span><p>Precipitation</p><strong>{weather?.precipitation != null ? `${weather.precipitation} mm` : '—'}</strong><small>{weather ? 'Current weather' : 'Unavailable'}</small></div>
            <div><span className="condition-icon flood"><Waves size={20} /></span><p>Flood risk</p><strong>Not assessed</strong><small>Needs dedicated risk data</small></div>
            <div><span className="condition-icon risk"><ShieldAlert size={20} /></span><p>Drought risk</p><strong>Not assessed</strong><small>Needs historical climate data</small></div>
          </div>
        </article>

        <article className="dashboard-panel dashboard-activity-panel">
          <div className="dashboard-panel-heading">
            <div><span>Timeline</span><h2>Recent activity</h2><p>Your latest workspace events</p></div>
            <CalendarClock size={22} />
          </div>
          <div className="dashboard-timeline">
            {hasAnalysis && analysis.createdAt ? (
              <div><span className="timeline-icon"><Satellite size={17} /></span><div><strong>Satellite analysis completed</strong><p>{analysis.location || 'Selected boundary'}</p><small>{new Date(analysis.createdAt).toLocaleString()}</small></div></div>
            ) : (
              <div><span className="timeline-icon"><Satellite size={17} /></span><div><strong>No previous analysis</strong><p>Run Satellite Analysis to create a saved result.</p><small>Waiting for data</small></div></div>
            )}
            <div><span className="timeline-icon timeline-account"><UserRound size={17} /></span><div><strong>Secure account session</strong><p>Signed in as {user?.email}</p><small>Supabase authentication</small></div></div>
          </div>
        </article>

        <article className="dashboard-panel dashboard-profile-panel">
          <div className="dashboard-panel-heading">
            <div><span>Account</span><h2>Profile</h2><p>Your authenticated workspace identity</p></div>
            <span className="dashboard-profile-heading-icon" aria-hidden="true">
              <UserRound size={20} />
            </span>
          </div>
          <div
            className="dashboard-profile-photo-block"
            tabIndex={0}
            onPaste={handleProfilePaste}
          >
            <div className="dashboard-profile-photo-avatar" aria-hidden="true">
              {profilePhoto ? (
                <img src={profilePhoto} alt="" />
              ) : (
                <UserRound size={26} />
              )}
            </div>

            <div className="dashboard-profile-photo-content">
              <strong>Profile picture</strong>
              <small>
                Choose an image from your device or paste one with Ctrl+V.
              </small>

              <div className="dashboard-profile-photo-actions">
                <label>
                  <ImagePlus size={14} />
                  {profilePhoto ? 'Change photo' : 'Choose photo'}
                  <input
                    type="file"
                    accept="image/*"
                    disabled={profilePhotoBusy}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) void storeProfileFile(file)
                      event.target.value = ''
                    }}
                  />
                </label>

                <button
                  type="button"
                  onClick={pasteProfilePhoto}
                  disabled={profilePhotoBusy}
                >
                  <Clipboard size={14} />
                  Paste
                </button>

                {profilePhoto && (
                  <button
                    className="profile-photo-remove"
                    type="button"
                    onClick={removeProfileImage}
                    disabled={profilePhotoBusy}
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          {profilePhotoMessage && (
            <p className="dashboard-profile-photo-message">
              {profilePhotoMessage}
            </p>
          )}

          <dl className="dashboard-profile-list">
            <div className="dashboard-profile-name-row">
              <dt>Full name</dt>

              <dd>
                {editingName ? (
                  <div className="dashboard-name-editor">
                    <input
                      type="text"
                      value={nameDraft}
                      maxLength={80}
                      autoFocus
                      disabled={nameSaving}
                      onChange={(event) =>
                        setNameDraft(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void saveProfileName()
                        }

                        if (event.key === 'Escape') {
                          setNameDraft(fullName)
                          setEditingName(false)
                          setNameMessage('')
                        }
                      }}
                      aria-label="Full name"
                    />

                    <button
                      className="dashboard-name-save"
                      type="button"
                      disabled={nameSaving}
                      onClick={() => void saveProfileName()}
                    >
                      <Check size={14} />
                      {nameSaving ? 'Saving...' : 'Save'}
                    </button>

                    <button
                      className="dashboard-name-cancel"
                      type="button"
                      disabled={nameSaving}
                      onClick={() => {
                        setNameDraft(fullName)
                        setEditingName(false)
                        setNameMessage('')
                      }}
                    >
                      <X size={14} />
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="dashboard-name-display">
                    <span>{fullName}</span>

                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(fullName)
                        setNameMessage('')
                        setEditingName(true)
                      }}
                      aria-label="Edit full name"
                      title="Edit full name"
                    >
                      <Pencil size={14} />
                      Edit
                    </button>
                  </div>
                )}

                {nameMessage && (
                  <small
                    className={
                      nameMessage === 'Name updated.'
                        ? 'dashboard-name-message success'
                        : 'dashboard-name-message'
                    }
                  >
                    {nameMessage}
                  </small>
                )}
              </dd>
            </div>
            <div><dt>Email</dt><dd>{user?.email}</dd></div>
            <div><dt>Email status</dt><dd className="profile-verified"><CheckCircle2 size={14} /> Verified</dd></div>
            <div><dt>Last sign in</dt><dd>{user?.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleDateString() : 'Current session'}</dd></div>
          </dl>
        </article>
      </section>

      <section className="dashboard-recommendation" id="recommendations">
        <div className="recommendation-icon"><Lightbulb size={27} /></div>
        <div>
          <span>Recommendation summary</span>
          <h2>{hasAnalysis ? 'Review the latest model output together with its uncertainty.' : 'Run a focused satellite analysis to generate recommendations.'}</h2>
          <p>
            The workspace does not invent crop-health, flood-risk, or drought-risk
            values from an RGB image. NDVI/NDWI requires suitable multispectral bands,
            while hazard risk needs separate historical and environmental data.
          </p>
        </div>
        <Link to={hasAnalysis ? '/recommendations' : '/satellite-analysis'}>{hasAnalysis ? 'View recommendations' : 'Start analysis'} <ArrowRight size={16} /></Link>
      </section>

      {assistantOpen && (
        <div className="dashboard-assistant" role="dialog" aria-modal="true" aria-label="AI guide">
          <button className="assistant-backdrop" type="button" aria-label="Close AI guide" onClick={() => setAssistantOpen(false)} />
          <section>
            <header><span><Bot size={20} /></span><div><strong>AgriTerrain Guide</strong><small>Interface assistant</small></div><button type="button" aria-label="Close AI guide" onClick={() => setAssistantOpen(false)}><X size={19} /></button></header>
            <div className="assistant-message"><MessageCircleQuestion size={18} /><p><strong>1. Run an analysis</strong><br />Open Satellite Analysis, search a location, draw a focused boundary, finish the boundary, choose a detection mode, and run the model.</p></div>
            <div className="assistant-message"><Satellite size={18} /><p><strong>2. Understand the result</strong><br />Crop/field detections appear in green, waterbodies in blue, and buildings in orange. Review model certainty and imagery quality before relying on a result.</p></div>
            <div className="assistant-message"><History size={18} /><p><strong>3. Review saved work</strong><br />Reports / History stores completed analyses. Saved Boundaries groups analysed areas, while Historical Compare helps review repeated analyses of the same location.</p></div>
            <div className="assistant-message"><Lightbulb size={18} /><p><strong>4. Use recommendations carefully</strong><br />Recommendations are generated only from saved model output and available weather context. The system does not invent NDVI, flood risk, or drought risk.</p></div>
            <div className="assistant-message assistant-warning"><Leaf size={18} /><p>AgriTerrain AI is an AI-assisted analysis tool. Important land or agricultural decisions should still be checked with local observations or trusted reference data.</p></div>
            <Link to="/satellite-analysis" onClick={() => setAssistantOpen(false)}>Start Satellite Analysis <ArrowRight size={16} /></Link>
          </section>
        </div>
      )}
    </WorkspaceShell>
  )
}

export default Dashboard
