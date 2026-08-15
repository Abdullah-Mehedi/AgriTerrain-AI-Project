import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import L from 'leaflet'
import {
  MapContainer,
  Marker,
  Polygon,
  ScaleControl,
  TileLayer,
  Tooltip,
  ZoomControl,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  Building2,
  Check,
  CloudRain,
  Crosshair,
  Download,
  Droplets,
  FileDown,
  Focus,
  History,
  Layers3,
  Leaf,
  LoaderCircle,
  LocateFixed,
  Map,
  MapPin,
  MousePointer2,
  RefreshCw,
  Satellite,
  Search,
  Sparkles,
  SquareDashedMousePointer,
  Thermometer,
  Undo2,
  Waves,
  Wind,
  X,
} from 'lucide-react'
import WorkspaceShell from '../components/WorkspaceShell'
import { useAuth } from '../context/auth-context'
import {
  MAX_ANALYSIS_SIDE_METRES,
  analyzeSatelliteBoundary,
  calculateBoundaryMetrics,
  checkMlService,
  fetchCurrentWeather,
  prepareMlModel,
} from '../services/satelliteAnalysis'
import {
  buildRecommendations,
  compactAnalysisForHistory,
  findPreviousComparableRecord,
  getAnalysisHistory,
  saveAnalysisHistoryRecord,
} from '../services/history'
import { generateAnalysisPdf } from '../services/reportPdf'
import 'leaflet/dist/leaflet.css'
import './SatelliteAnalysis.css'

const INITIAL_CENTER = [24.3745, 88.6042]

const ANALYSIS_MODE_ESTIMATES = {
  faster: '~1m 30s',
  balanced: '~2m 55s',
  standard: '~4m 14s',
}

function formatAnalysisDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—'

  const totalSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60

  if (minutes <= 0) return `${remainingSeconds}s`

  return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`
}

const classDetails = {
  crop: {
    label: 'Crop zones',
    singular: 'Crop region',
    colour: '#39b14d',
    className: 'detection-crop',
    icon: Leaf,
  },
  water: {
    label: 'Waterbodies',
    singular: 'Water region',
    colour: '#258ed3',
    className: 'detection-water',
    icon: Waves,
  },
  building: {
    label: 'Building regions',
    singular: 'Building region',
    colour: '#e88433',
    className: 'detection-building',
    icon: Building2,
  },
}

const locationIcon = L.divIcon({
  className: 'agriterrain-location-marker',
  html: '<span></span>',
  iconAnchor: [14, 28],
  iconSize: [28, 28],
})

function MapSynchronizer({ center, zoom }) {
  const map = useMap()

  useEffect(() => {
    map.flyTo(center, zoom, { duration: 0.8 })
  }, [center, map, zoom])

  return null
}

function BoundaryClickHandler({ enabled, onPoint }) {
  useMapEvents({
    click(event) {
      if (enabled) onPoint([event.latlng.lat, event.latlng.lng])
    },
  })

  return null
}

function MapInteractionController({ locked }) {
  const map = useMap()

  useEffect(() => {
    const handlers = [
      map.dragging,
      map.touchZoom,
      map.doubleClickZoom,
      map.scrollWheelZoom,
      map.boxZoom,
      map.keyboard,
    ]
    handlers.forEach((handler) => {
      if (!handler) return
      if (locked) handler.disable()
      else handler.enable()
    })
  }, [locked, map])

  return null
}

function formatCoverageChange(current, previous) {
  const difference = Number(current || 0) - Number(previous || 0)
  return `${difference >= 0 ? '+' : ''}${difference.toFixed(1)} pp`
}

function weatherLabel(code) {
  if (code === 0) return 'Clear sky'
  if ([1, 2, 3].includes(code)) return 'Partly cloudy'
  if ([45, 48].includes(code)) return 'Foggy'
  if (code >= 51 && code <= 67) return 'Rain expected'
  if (code >= 80 && code <= 82) return 'Rain showers'
  if (code >= 95) return 'Thunderstorm risk'
  return 'Current conditions'
}

function formatDistance(value) {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(2)} km`
  return `${Math.round(value)} m`
}

function serviceLabel(serviceStatus, preparingModel) {
  if (preparingModel || serviceStatus.status === 'downloading') {
    return 'Preparing AI model'
  }
  if (!serviceStatus.online) return 'AI service offline'
  if (serviceStatus.modelReady) return 'Real AI ready'
  return 'Model download required'
}

function SatelliteAnalysis() {
  const { user } = useAuth()
  const [mapCenter, setMapCenter] = useState(INITIAL_CENTER)
  const [mapZoom, setMapZoom] = useState(17)
  const [mapStyle, setMapStyle] = useState('satellite')
  const [mapLocked, setMapLocked] = useState(false)
  const [selectedLocation, setSelectedLocation] = useState({
    name: 'Rajshahi, Bangladesh',
    coordinates: INITIAL_CENTER,
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [boundary, setBoundary] = useState([])
  const [drawing, setDrawing] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [analysisStatus, setAnalysisStatus] = useState('idle')
  const [analysisMessage, setAnalysisMessage] = useState(
    'Search for a location, zoom in, then draw a compact analysis boundary.',
  )
  const [activeResultTab, setActiveResultTab] = useState('overview')
  const [showOverlay, setShowOverlay] = useState(true)
  const [visibleClasses, setVisibleClasses] = useState({
    crop: true,
    water: true,
    building: true,
  })
  // Standard mode preserves the existing detection threshold exactly.
  const confidenceThreshold = 0.55
  const [analysisMode, setAnalysisMode] = useState('standard')
  const [analysisStartedAt, setAnalysisStartedAt] = useState(null)
  const [analysisElapsedSeconds, setAnalysisElapsedSeconds] = useState(null)
  const [serviceStatus, setServiceStatus] = useState({
    online: false,
    modelReady: false,
    modelLoaded: false,
    status: 'checking',
    model: 'OpenEarthMap U-Net EfficientNet-B4',
    downloadMb: 304,
    detail: '',
  })
  const [preparingModel, setPreparingModel] = useState(false)
  const [weather, setWeather] = useState(null)
  const [weatherLoading, setWeatherLoading] = useState(true)
  const [history, setHistory] = useState(() => getAnalysisHistory(user?.id))
  const [currentHistoryRecord, setCurrentHistoryRecord] = useState(null)

  const boundaryMetrics = useMemo(
    () => calculateBoundaryMetrics(boundary),
    [boundary],
  )

  useEffect(() => {
    if (analysisStatus !== 'running' || analysisStartedAt === null) {
      return undefined
    }

    const updateElapsedTime = () => {
      setAnalysisElapsedSeconds(
        (performance.now() - analysisStartedAt) / 1000,
      )
    }

    updateElapsedTime()
    const intervalId = window.setInterval(updateElapsedTime, 1000)

    return () => window.clearInterval(intervalId)
  }, [analysisStatus, analysisStartedAt])

  const completedAnalysisTime =
    analysisStatus === 'complete' &&
    Number.isFinite(analysisElapsedSeconds)

  const analysisTimeHeading =
    analysisStatus === 'running'
      ? 'Elapsed analysis time'
      : completedAnalysisTime
        ? 'Actual analysis time'
        : 'Estimated analysis time'

  const analysisTimeDetail =
    analysisStatus === 'running'
      ? 'Live timer while detection runs'
      : completedAnalysisTime
        ? 'Measured for the latest completed detection'
        : 'Standard mode benchmark'

  const analysisTimeValue =
    analysisStatus === 'running'
      ? formatAnalysisDuration(analysisElapsedSeconds ?? 0)
      : completedAnalysisTime
        ? formatAnalysisDuration(analysisElapsedSeconds)
        : ANALYSIS_MODE_ESTIMATES[analysisMode]
  const overlayBounds = analysis?.bbox
    ? [
        [analysis.bbox.south, analysis.bbox.west],
        [analysis.bbox.north, analysis.bbox.east],
      ]
    : null
  const activeHistoryRecord = useMemo(
    () =>
      currentHistoryRecord ||
      compactAnalysisForHistory({
        analysis,
        weather,
        boundary,
        coordinates: selectedLocation.coordinates,
      }),
    [analysis, boundary, currentHistoryRecord, selectedLocation.coordinates, weather],
  )
  const previousComparable = useMemo(
    () => findPreviousComparableRecord(history, activeHistoryRecord),
    [activeHistoryRecord, history],
  )
  const recommendations = useMemo(
    () => buildRecommendations(activeHistoryRecord),
    [activeHistoryRecord],
  )

  async function refreshServiceStatus() {
    setServiceStatus((current) => ({ ...current, status: 'checking' }))
    const nextStatus = await checkMlService()
    setServiceStatus(nextStatus)
    return nextStatus
  }

  useEffect(() => {
    let active = true

    checkMlService().then((nextStatus) => {
      if (active) setServiceStatus(nextStatus)
    })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true

    fetchCurrentWeather(selectedLocation.coordinates, selectedLocation.name)
      .then((nextWeather) => {
        if (active) {
          setWeather(nextWeather)
          localStorage.setItem(
            'agriterrain_latest_weather',
            JSON.stringify(nextWeather),
          )
        }
      })
      .catch(() => {
        if (active) setWeather(null)
      })
      .finally(() => {
        if (active) setWeatherLoading(false)
      })

    return () => {
      active = false
    }
  }, [selectedLocation])

  async function handleSearch(event) {
    event.preventDefault()
    const query = searchQuery.trim()

    if (query.length < 2) {
      setSearchError('Enter at least two characters, such as Rajshahi or Bogura.')
      return
    }

    try {
      setSearching(true)
      setSearchError('')
      const parameters = new URLSearchParams({
        q: `${query}, Bangladesh`,
        format: 'jsonv2',
        countrycodes: 'bd',
        addressdetails: '1',
        limit: '5',
      })
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${parameters}`,
        { headers: { 'Accept-Language': 'en' } },
      )

      if (!response.ok) throw new Error('Location search failed.')
      const results = await response.json()
      setSearchResults(results)
      if (!results.length) {
        setSearchError('No Bangladesh locations matched that search.')
      }
    } catch (error) {
      setSearchError(
        error.message || 'Location search is temporarily unavailable.',
      )
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  function resetAnalysis(message) {
    setBoundary([])
    setDrawing(false)
    setMapLocked(false)
    setAnalysis(null)
    setCurrentHistoryRecord(null)
    setAnalysisStatus('idle')
    setAnalysisMessage(message)
  }

  function chooseLocation(result) {
    const coordinates = [Number(result.lat), Number(result.lon)]
    setWeatherLoading(true)
    setSelectedLocation({ name: result.display_name, coordinates })
    setMapCenter(coordinates)
    setMapZoom(17)
    setSearchQuery(result.display_name.split(',')[0])
    setSearchResults([])
    resetAnalysis(`Location selected. Zoom in and draw an area below ${MAX_ANALYSIS_SIDE_METRES} m across.`)
  }

  function locateUser() {
    if (!navigator.geolocation) {
      setAnalysisMessage('Location access is not supported by this browser.')
      return
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const coordinates = [coords.latitude, coords.longitude]
        setWeatherLoading(true)
        setSelectedLocation({ name: 'Your current location', coordinates })
        setMapCenter(coordinates)
        setMapZoom(17)
        resetAnalysis('Location found. Draw a compact boundary around the target area.')
      },
      () => setAnalysisMessage('Location permission was not available.'),
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  function startDrawing() {
    setBoundary([])
    setDrawing(true)
    setMapLocked(false)
    setAnalysis(null)
    setAnalysisStatus('idle')
    setAnalysisMessage(
      `Click at least three points on the map. Keep the longest side below ${MAX_ANALYSIS_SIDE_METRES} m.`,
    )
  }

  function addBoundaryPoint(point) {
    if (boundary.length >= 80) {
      setAnalysisMessage('The boundary already has the maximum of 80 points.')
      return
    }
    setBoundary((current) => [...current, point])
  }

  function finishDrawing() {
    if (boundary.length < 3) {
      setAnalysisMessage('Add at least three map points before finishing.')
      return
    }
    setDrawing(false)
    if (!boundaryMetrics.validForAnalysis) {
      setAnalysisMessage(
        `This selection is ${formatDistance(boundaryMetrics.longestSideMetres)} across. Zoom in and keep it below ${MAX_ANALYSIS_SIDE_METRES} m.`,
      )
      return
    }
    setMapLocked(true)
    setAnalysisMessage(
      `Boundary ready at about ${boundaryMetrics.estimatedGsdMetres.toFixed(2)} m/pixel. Locked Map is active for the fixed analysis area.`,
    )
  }

  function undoBoundaryPoint() {
    setBoundary((current) => current.slice(0, -1))
    setAnalysis(null)
    setAnalysisStatus('idle')
  }

  function clearBoundary() {
    resetAnalysis('Boundary cleared. Select Draw boundary to start again.')
  }

  async function handlePrepareModel() {
    if (!serviceStatus.online) {
      setAnalysisMessage(
        'Start ml-service\\start-service.bat first, then check the service again.',
      )
      return
    }

    try {
      setPreparingModel(true)
      setAnalysisMessage(
        'Downloading and validating the OpenEarthMap model. Keep the AI-service window open.',
      )
      await prepareMlModel()
      const nextStatus = await refreshServiceStatus()
      if (!nextStatus.modelReady) {
        throw new Error('The model service did not report a ready model.')
      }
      setAnalysisMessage('OpenEarthMap model ready. You can run real AI detection.')
    } catch (error) {
      setAnalysisMessage(error.message || 'The AI model could not be prepared.')
    } finally {
      setPreparingModel(false)
    }
  }

  async function runAnalysis() {
    if (!serviceStatus.online) {
      setAnalysisMessage('The real AI service is offline. No fake result will be generated.')
      return
    }
    if (!serviceStatus.modelReady) {
      setAnalysisMessage('Prepare the OpenEarthMap model before running detection.')
      return
    }
    if (!boundaryMetrics.validForAnalysis) {
      setAnalysisMessage(
        `Draw an area between 20 m and ${MAX_ANALYSIS_SIDE_METRES} m across.`,
      )
      return
    }

    const startedAt = performance.now()

    setDrawing(false)
    setAnalysisStatus('running')
    setAnalysis(null)
    setAnalysisStartedAt(startedAt)
    setAnalysisElapsedSeconds(0)
    setActiveResultTab('overview')
    setAnalysisMessage(
      'Fetching the exact RGB map image and running four-view OpenEarthMap inference...',
    )

    try {
      const result = await analyzeSatelliteBoundary(
        boundary,
        selectedLocation.name,
        {
          confidenceThreshold,
          quality: analysisMode === 'faster' ? 'fast' : 'accurate',
          analysisMode,
        },
      )
      setAnalysis(result)
      setAnalysisElapsedSeconds(
        (performance.now() - startedAt) / 1000,
      )
      setAnalysisStartedAt(null)
      setAnalysisStatus('complete')
      const record = compactAnalysisForHistory({
        analysis: result,
        weather,
        boundary,
        coordinates: selectedLocation.coordinates,
      })
      setCurrentHistoryRecord(record)
      try {
        localStorage.setItem(
          'agriterrain_latest_analysis',
          JSON.stringify({ ...record, mode: 'ml' }),
        )
        if (record) {
          setHistory(saveAnalysisHistoryRecord(user?.id, record))
        }
        setAnalysisMessage(
          'Real model inference completed and saved to Reports / History. Review imagery quality and uncertainty before using the result.',
        )
      } catch {
        setAnalysisMessage(
          'Real model inference completed, but this browser could not save the result to local history.',
        )
      }
    } catch (error) {
      setAnalysisElapsedSeconds(
        (performance.now() - startedAt) / 1000,
      )
      setAnalysisStartedAt(null)
      setAnalysisStatus('error')
      setAnalysisMessage(error.message || 'Unable to complete real AI analysis.')
    }
  }

  function toggleClass(classKey) {
    setVisibleClasses((current) => ({
      ...current,
      [classKey]: !current[classKey],
    }))
  }

  const runDisabled =
    analysisStatus === 'running' ||
    drawing ||
    !boundaryMetrics.validForAnalysis ||
    !serviceStatus.online ||
    !serviceStatus.modelReady

  return (
    <WorkspaceShell
      title="Satellite Analysis"
      description="Select a high-resolution area and detect crop zones, waterbodies, and buildings with a real model."
      headerActions={
        <div
          className={`satellite-service-badge service-${serviceStatus.status} no-print`}
          title={serviceStatus.detail || serviceStatus.model}
        >
          {serviceStatus.status === 'checking' || preparingModel ? (
            <LoaderCircle className="satellite-spinner" size={15} />
          ) : (
            <span />
          )}
          {serviceLabel(serviceStatus, preparingModel)}
        </div>
      }
    >
      <section className="satellite-process-strip no-print" aria-label="Analysis steps">
        <div className="process-step process-step-active">
          <span>1</span>
          <p><strong>Find location</strong><small>Search or use your position</small></p>
        </div>
        <i />
        <div className={boundary.length >= 3 ? 'process-step process-step-active' : 'process-step'}>
          <span>2</span>
          <p><strong>Draw a small area</strong><small>Maximum {MAX_ANALYSIS_SIDE_METRES} m per side</small></p>
        </div>
        <i />
        <div className={analysisStatus === 'complete' ? 'process-step process-step-active' : 'process-step'}>
          <span>3</span>
          <p><strong>Run real AI</strong><small>Inspect masks and uncertainty</small></p>
        </div>
      </section>

      <section className="satellite-workspace-grid">
        <aside className="satellite-control-column no-print">
          <article className="satellite-panel">
            <div className="satellite-panel-heading">
              <span><Search size={18} /></span>
              <div><strong>1. Find location</strong><small>Bangladesh place search</small></div>
            </div>

            <form className="satellite-search-form" onSubmit={handleSearch}>
              <div>
                <MapPin size={17} />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="District, upazila, village..."
                  aria-label="Search Bangladesh location"
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchQuery('')
                      setSearchResults([])
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <button type="submit" disabled={searching} aria-label="Search location">
                {searching ? <LoaderCircle className="satellite-spinner" size={18} /> : <Search size={18} />}
              </button>
            </form>

            <button className="satellite-location-button" type="button" onClick={locateUser}>
              <LocateFixed size={16} /> Use my current location
            </button>

            {searchError && <p className="satellite-inline-error">{searchError}</p>}

            {searchResults.length > 0 && (
              <div className="satellite-search-results">
                {searchResults.map((result) => (
                  <button key={result.place_id} type="button" onClick={() => chooseLocation(result)}>
                    <MapPin size={16} />
                    <span><strong>{result.display_name.split(',')[0]}</strong><small>{result.display_name}</small></span>
                  </button>
                ))}
              </div>
            )}

            <div className="selected-location">
              <Crosshair size={16} />
              <div><span>Selected location</span><strong>{selectedLocation.name}</strong></div>
            </div>
          </article>

          <article className="satellite-panel model-readiness-panel">
            <div className="satellite-panel-heading">
              <span><BrainCircuit size={18} /></span>
              <div><strong>2. Prepare real AI</strong><small>No demonstration fallback</small></div>
            </div>

            <div className={`model-readiness-state readiness-${serviceStatus.status}`}>
              <span>{serviceStatus.modelReady ? <Check size={18} /> : <BrainCircuit size={18} />}</span>
              <div>
                <strong>{serviceLabel(serviceStatus, preparingModel)}</strong>
                <small>
                  {!serviceStatus.online
                    ? 'Start the included Python service.'
                    : serviceStatus.modelReady
                      ? 'OpenEarthMap weights are available.'
                      : `One-time download: about ${serviceStatus.downloadMb} MB.`}
                </small>
              </div>
            </div>

            {!serviceStatus.online && (
              <p className="service-start-note">
                Open <code>ml-service\start-service.bat</code>, keep it running, then check again.
              </p>
            )}

            <div className="model-action-row">
              <button type="button" onClick={refreshServiceStatus} disabled={preparingModel}>
                <RefreshCw size={15} /> Check service
              </button>
              {serviceStatus.online && !serviceStatus.modelReady && (
                <button
                  className="prepare-model-button"
                  type="button"
                  onClick={handlePrepareModel}
                  disabled={preparingModel}
                >
                  {preparingModel ? <LoaderCircle className="satellite-spinner" size={15} /> : <Download size={15} />}
                  {preparingModel ? 'Preparing...' : 'Prepare model'}
                </button>
              )}
            </div>
          </article>

          <article className="satellite-panel boundary-panel">
            <div className="satellite-panel-heading">
              <span><SquareDashedMousePointer size={18} /></span>
              <div><strong>3. Select analysis area</strong><small>Small areas preserve object detail</small></div>
            </div>

            <button className="draw-boundary-button" type="button" onClick={startDrawing}>
              <MousePointer2 size={17} />
              {drawing ? 'Drawing—click on map' : 'Draw new boundary'}
            </button>

            <div className="boundary-action-row">
              <button type="button" onClick={undoBoundaryPoint} disabled={!boundary.length}>
                <Undo2 size={15} /> Undo
              </button>
              <button type="button" onClick={finishDrawing} disabled={boundary.length < 3 || !drawing}>
                <Check size={15} /> Finish
              </button>
              <button type="button" onClick={clearBoundary} disabled={!boundary.length}>
                <X size={15} /> Clear
              </button>
            </div>

            <div className="boundary-metrics-grid">
              <div><span>Points</span><strong>{boundary.length}</strong></div>
              <div><span>Area</span><strong>{boundaryMetrics.areaHectares.toFixed(2)} ha</strong></div>
              <div><span>Longest side</span><strong>{formatDistance(boundaryMetrics.longestSideMetres)}</strong></div>
              <div><span>Est. detail</span><strong>{boundary.length >= 3 ? `${boundaryMetrics.estimatedGsdMetres.toFixed(2)} m/px` : '—'}</strong></div>
            </div>

            {boundary.length >= 3 && (
              <div className={`selection-quality quality-${boundaryMetrics.validForAnalysis ? boundaryMetrics.quality : 'poor'}`}>
                {boundaryMetrics.validForAnalysis ? <Focus size={16} /> : <AlertTriangle size={16} />}
                <p>
                  <strong>{boundaryMetrics.validForAnalysis ? `${boundaryMetrics.quality} input detail` : 'Selection is too large or narrow'}</strong>
                  <small>{boundaryMetrics.validForAnalysis ? 'Suitable for high-resolution RGB segmentation.' : `Keep every side between 20 m and ${MAX_ANALYSIS_SIDE_METRES} m.`}</small>
                </p>
              </div>
            )}
          </article>

          <article className="satellite-panel analysis-mode-panel">
            <div className="analysis-mode-heading">
              <div>
                <strong>4. Analysis mode</strong>
                <small>Choose the mode that fits your priority.</small>
              </div>
            </div>

            <div className="analysis-mode-list">
              <button
                className={`analysis-mode-option ${analysisMode === 'faster' ? 'active' : ''}`}
                type="button"
                onClick={() => setAnalysisMode('faster')}
                aria-pressed={analysisMode === 'faster'}
              >
                <span className="analysis-mode-icon">⚡</span>
                <span className="analysis-mode-copy">
                  <span className="analysis-mode-title">Faster</span>
                  <small>
                    Estimated time: {ANALYSIS_MODE_ESTIMATES.faster}
                  </small>
                </span>
                <span className={`analysis-mode-radio ${analysisMode === 'faster' ? 'selected' : ''}`} />
              </button>

              <button
                className={`analysis-mode-option ${analysisMode === 'balanced' ? 'active' : ''}`}
                type="button"
                onClick={() => setAnalysisMode('balanced')}
                aria-pressed={analysisMode === 'balanced'}
              >
                <span className="analysis-mode-icon">⚖</span>
                <span className="analysis-mode-copy">
                  <span className="analysis-mode-title">
                    Balanced
                    <em>Recommended</em>
                  </span>
                  <small>
                    Estimated time: {ANALYSIS_MODE_ESTIMATES.balanced}
                  </small>
                </span>
                <span className={`analysis-mode-radio ${analysisMode === 'balanced' ? 'selected' : ''}`} />
              </button>

              <button
                className={`analysis-mode-option ${analysisMode === 'standard' ? 'active' : ''}`}
                type="button"
                onClick={() => setAnalysisMode('standard')}
                aria-pressed={analysisMode === 'standard'}
              >
                <span className="analysis-mode-icon">🎯</span>
                <span className="analysis-mode-copy">
                  <span className="analysis-mode-title">Standard</span>
                  <small>
                    Estimated time: {ANALYSIS_MODE_ESTIMATES.standard}
                  </small>
                </span>
                <span className={`analysis-mode-radio ${analysisMode === 'standard' ? 'selected' : ''}`} />
              </button>
            </div>
          </article>

          <div className={`satellite-message message-${analysisStatus}`} role="status">
            {analysisStatus === 'error' ? <AlertCircle size={17} /> : <Sparkles size={17} />}
            <span>{analysisMessage}</span>
          </div>
        </aside>

        <section className="satellite-map-column">
          <article className="satellite-map-card">
            <header className="satellite-map-toolbar no-print">
              <div>
                <span><Satellite size={19} /></span>
                <p><strong>High-resolution selection map</strong><small>{selectedLocation.name}</small></p>
              </div>
              <div className="satellite-map-toolbar-actions">
                <div className="map-source-switch">
                  <button className={mapStyle === 'satellite' ? 'active' : ''} type="button" onClick={() => setMapStyle('satellite')}>
                    <Satellite size={16} /> Satellite
                  </button>
                  <button className={mapStyle === 'street' ? 'active' : ''} type="button" onClick={() => setMapStyle('street')}>
                    <Map size={16} /> Street
                  </button>
                </div>
                <div className="map-source-switch map-mode-switch">
                  <button className={!mapLocked ? 'active' : ''} type="button" onClick={() => setMapLocked(false)}>Live Map</button>
                  <button className={mapLocked ? 'active' : ''} type="button" onClick={() => setMapLocked(true)} disabled={boundary.length < 3}>Locked Map</button>
                </div>
              </div>
            </header>

            <div className={drawing ? 'satellite-map-wrap map-is-drawing' : 'satellite-map-wrap'}>
              <MapContainer
                center={mapCenter}
                zoom={mapZoom}
                minZoom={4}
                maxZoom={20}
                zoomControl={false}
                className="satellite-leaflet-map"
              >
                <MapSynchronizer center={mapCenter} zoom={mapZoom} />
                <MapInteractionController locked={mapLocked && !drawing} />
                <BoundaryClickHandler enabled={drawing} onPoint={addBoundaryPoint} />
                {!mapLocked && <ZoomControl position="bottomright" />}
                <ScaleControl position="bottomleft" imperial={false} />

                {mapStyle === 'satellite' ? (
                  <TileLayer
                    attribution="Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics"
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    maxZoom={20}
                  />
                ) : (
                  <TileLayer
                    attribution="© OpenStreetMap contributors"
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    maxZoom={19}
                  />
                )}

                <Marker position={selectedLocation.coordinates} icon={locationIcon}>
                  <Tooltip direction="top" offset={[0, -26]}>{selectedLocation.name}</Tooltip>
                </Marker>

                {boundary.length >= 2 && (
                  <Polygon
                    positions={boundary}
                    pathOptions={{ color: '#9aec6a', weight: 3, fillColor: '#9aec6a', fillOpacity: 0.08 }}
                  >
                    <Tooltip sticky>Selected analysis boundary</Tooltip>
                  </Polygon>
                )}

                {showOverlay && analysis && Object.entries(classDetails).map(([classKey, details]) => (
                  visibleClasses[classKey] && analysis.detections[classKey].map((region) => (
                      <Polygon
                        key={region.id}
                        positions={region.coordinates}
                        pathOptions={{ color: details.colour, weight: 2, fillColor: details.colour, fillOpacity: classKey === 'building' ? 0.42 : 0.3 }}
                      >
                        <Tooltip sticky>{details.singular} · {region.areaM2.toFixed(0)} m² · {region.confidence.toFixed(0)}% model certainty</Tooltip>
                      </Polygon>
                  ))
                ))}
              </MapContainer>

              {drawing && (
                <div className="map-drawing-instruction">
                  <MousePointer2 size={16} /> Click map points, then choose Finish
                </div>
              )}

              <div className="map-legend no-print">
                <header>
                  <strong>Detection layers</strong>
                  <label>
                    <input type="checkbox" checked={showOverlay} onChange={(event) => setShowOverlay(event.target.checked)} />
                    Show
                  </label>
                </header>
                {Object.entries(classDetails).map(([classKey, details]) => {
                  const Icon = details.icon
                  return (
                    <button
                      key={classKey}
                      className={visibleClasses[classKey] ? 'active' : ''}
                      type="button"
                      onClick={() => toggleClass(classKey)}
                      disabled={!analysis}
                    >
                      <i style={{ background: details.colour }} />
                      <Icon size={14} />
                      <span>{details.label}</span>
                      {analysis && <strong>{analysis.counts[classKey]}</strong>}
                    </button>
                  )
                })}
              </div>
            </div>

            <footer className="satellite-source-note">
              <span><Layers3 size={18} /></span>
              <p>
                <strong>Imagery and analysis source</strong>
                <small>Esri World Imagery RGB · OpenEarthMap U-Net EfficientNet-B4 · {mapLocked ? 'Locked Map' : 'Live Map'}</small>
              </p>
              <span className={`source-resolution resolution-${boundaryMetrics.quality}`}>
                {boundary.length >= 3 ? `~${boundaryMetrics.estimatedGsdMetres.toFixed(2)} m/px` : 'Zoom 17–20'}
              </span>
            </footer>
          </article>

          <div className="analysis-action-row">
            <button
              className="run-analysis-button"
              type="button"
              onClick={runAnalysis}
              disabled={runDisabled}
            >
              {analysisStatus === 'running'
                ? <LoaderCircle className="satellite-spinner" size={20} />
                : <BrainCircuit size={20} />}
              {analysisStatus === 'running'
                ? 'Running real AI...'
                : 'Run real AI detection'}
            </button>

            <article className="satellite-panel analysis-time-panel">
              <div className="analysis-time-icon">⏱</div>

              <div className="analysis-time-copy">
                <strong>{analysisTimeHeading}</strong>
                <small>{analysisTimeDetail}</small>
              </div>

              <div className="analysis-time-value">
                <strong>{analysisTimeValue}</strong>
                <small>
                  {analysisStatus === 'running'
                    ? 'counting now'
                    : completedAnalysisTime
                      ? 'actual duration'
                      : 'varies by area'}
                </small>
              </div>
            </article>
          </div>
        </section>

        <aside className="satellite-results-column">
          <article className="satellite-panel satellite-results-panel">
            <header>
              <div><span>Selected-area inference</span><h2>Detection results</h2></div>
              <strong className={analysis ? 'result-mode result-mode-live' : 'result-mode'}>
                {analysis ? 'Real AI output' : 'Awaiting analysis'}
              </strong>
            </header>

            {analysisStatus === 'running' && (
              <div className="analysis-loading-state">
                <span><BrainCircuit size={32} /></span>
                <h3>Analysing the selected image</h3>
                <p>Running four orientations improves consistency but takes longer on CPU.</p>
                <div><i /><i /><i /></div>
              </div>
            )}

            {analysisStatus !== 'running' && !analysis && (
              <div className="analysis-empty-state">
                <span>{analysisStatus === 'error' ? <AlertCircle size={31} /> : <Focus size={31} />}</span>
                <h3>{analysisStatus === 'error' ? 'Analysis did not complete' : 'No generated data'}</h3>
                <p>{analysisStatus === 'error' ? analysisMessage : 'The panel stays empty until the real model returns a result. Nothing is simulated.'}</p>
                <div><small>1</small><span>Find</span><i /><small>2</small><span>Draw</span><i /><small>3</small><span>Detect</span></div>
              </div>
            )}

            {analysis && (
              <>
                <nav className="result-tabs" aria-label="Result sections">
                  <button className={activeResultTab === 'overview' ? 'active' : ''} type="button" onClick={() => setActiveResultTab('overview')}>Overview</button>
                  <button className={activeResultTab === 'evidence' ? 'active' : ''} type="button" onClick={() => setActiveResultTab('evidence')}>Evidence</button>
                  <button className={activeResultTab === 'insights' ? 'active' : ''} type="button" onClick={() => setActiveResultTab('insights')}>Insights</button>
                  <button className={activeResultTab === 'history' ? 'active' : ''} type="button" onClick={() => setActiveResultTab('history')}>History</button>
                  <button className={activeResultTab === 'weather' ? 'active' : ''} type="button" onClick={() => setActiveResultTab('weather')}>Weather</button>
                  <button className={activeResultTab === 'sources' ? 'active' : ''} type="button" onClick={() => setActiveResultTab('sources')}>Sources</button>
                </nav>

                {activeResultTab === 'overview' && (
                  <div className="result-overview">
                    <div className="result-location-summary">
                      <MapPin size={17} />
                      <div>
                        <span>Analysed location</span>
                        <strong>{analysis.location}</strong>
                        <small>{analysis.areaHectares.toFixed(2)} ha · threshold {analysis.confidenceThreshold.toFixed(0)}%</small>
                      </div>
                    </div>

                    <div className="detection-count-grid">
                      {Object.entries(classDetails).map(([classKey, details]) => {
                        const Icon = details.icon
                        return (
                          <div key={classKey}>
                            <span className={details.className}><Icon size={17} /></span>
                            <strong>{analysis.counts[classKey]}</strong>
                            <small>{details.label}</small>
                          </div>
                        )
                      })}
                    </div>

                    <p className="region-count-note">Counts represent separated AI mask regions, not verified parcel or house totals.</p>

                    <div className="coverage-heading">
                      <strong>Selected-area coverage</strong>
                      <span>{analysis.meanModelCertainty.toFixed(0)}% mean certainty</span>
                    </div>
                    <div className="coverage-list">
                      {Object.entries(classDetails).map(([classKey, details]) => (
                        <div key={classKey}>
                          <p><span>{details.label}</span><strong>{analysis.coverage[classKey].toFixed(1)}%</strong></p>
                          <div><i style={{ width: `${Math.min(analysis.coverage[classKey], 100)}%`, background: details.colour }} /></div>
                        </div>
                      ))}
                    </div>

                    <div className="analysis-warning">
                      <AlertTriangle size={16} />
                      <span>{analysis.warning}</span>
                    </div>
                  </div>
                )}

                {activeResultTab === 'evidence' && (
                  <div className="evidence-result">
                    <div className="model-identity">
                      <span><BrainCircuit size={23} /></span>
                      <div>
                        <small>Inference model</small>
                        <strong>{analysis.model.name}</strong>
                        <p>{analysis.model.input} · {analysis.model.test_time_augmentation ? 'four-view TTA enabled' : 'single-view inference'}</p>
                      </div>
                    </div>

                    <dl className="evidence-list">
                      <div><dt>Imagery</dt><dd>{analysis.imagery.provider}</dd></div>
                      <div><dt>Estimated detail</dt><dd>{Number(analysis.imagery.estimated_gsd_metres || 0).toFixed(2)} m/pixel · {analysis.imagery.quality_rating}</dd></div>
                      <div><dt>Current certainty</dt><dd>{analysis.meanModelCertainty.toFixed(1)}% mean softmax probability</dd></div>
                      <div><dt>User threshold</dt><dd>{analysis.confidenceThreshold.toFixed(0)}% requested minimum</dd></div>
                      {analysis.classThresholds && (
                        <div><dt>Precision floors</dt><dd>Crop {analysis.classThresholds.crop.toFixed(0)}% · Water {analysis.classThresholds.water.toFixed(0)}% · Building {analysis.classThresholds.building.toFixed(0)}%</dd></div>
                      )}
                    </dl>

                    <div className="benchmark-card">
                      <strong>OpenEarthMap validation benchmark</strong>
                      <div>
                        <span>Crop IoU <b>{analysis.model.benchmark?.crop_iou ?? '—'}%</b></span>
                        <span>Water IoU <b>{analysis.model.benchmark?.water_iou ?? '—'}%</b></span>
                        <span>Building IoU <b>{analysis.model.benchmark?.building_iou ?? '—'}%</b></span>
                      </div>
                      <p>These published validation scores are not the measured accuracy of this Bangladesh image.</p>
                    </div>

                    <p className="model-honesty-note">
                      <AlertCircle size={16} />
                      Confidence is model certainty, not guaranteed correctness. Local labelled examples are needed to measure Bangladesh accuracy.
                    </p>
                  </div>
                )}

                {activeResultTab === 'insights' && (
                  <div className="insights-result">
                    <div className="science-status-card">
                      <Leaf size={20} />
                      <p><strong>Crop health / NDVI status</strong><span>Not calculated from this RGB image. Scientifically meaningful NDVI/NDWI requires suitable multispectral bands.</span></p>
                    </div>
                    <div className="insight-facts-grid">
                      <div><small>Crop-labelled cover</small><strong>{analysis.coverage.crop.toFixed(1)}%</strong></div>
                      <div><small>Water-labelled cover</small><strong>{analysis.coverage.water.toFixed(1)}%</strong></div>
                      <div><small>Built-labelled cover</small><strong>{analysis.coverage.building.toFixed(1)}%</strong></div>
                      <div><small>Possible crop species</small><strong>Not classified</strong></div>
                      <div><small>Flood risk</small><strong>Not assessed</strong></div>
                      <div><small>Drought risk</small><strong>Not assessed</strong></div>
                      <div><small>Crop / animal disease</small><strong>Not assessed</strong></div>
                      <div><small>Fish cultivation</small><strong>Needs local data</strong></div>
                    </div>
                    <p className="result-data-note">This land-cover model identifies broad classes only. Crop species, disease, flood/drought risk, and fishery suitability require separate reliable datasets, so the interface leaves them unavailable rather than guessing.</p>
                    <strong className="recommendation-title">Recommendations</strong>
                    <ul className="recommendation-list">{recommendations.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                )}

                {activeResultTab === 'history' && (
                  <div className="history-result">
                    <div className="history-heading"><History size={20} /><p><strong>Saved historical comparison</strong><span>Compares records with the exact same saved location name.</span></p></div>
                    {previousComparable ? (
                      <>
                        <p className="history-date">Previous saved analysis: {new Date(previousComparable.createdAt).toLocaleString()}</p>
                        <div className="history-change-grid">
                          <div><small>Crop cover</small><strong>{formatCoverageChange(analysis.coverage.crop, previousComparable.coverage?.crop)}</strong></div>
                          <div><small>Water cover</small><strong>{formatCoverageChange(analysis.coverage.water, previousComparable.coverage?.water)}</strong></div>
                          <div><small>Built cover</small><strong>{formatCoverageChange(analysis.coverage.building, previousComparable.coverage?.building)}</strong></div>
                        </div>
                        <p className="history-caveat">Analysis time is not necessarily imagery capture time. Use dated satellite products for scientific land-change measurement.</p>
                      </>
                    ) : (
                      <p className="history-caveat">No earlier saved analysis matches this exact location yet. Analyze the same place later to create a comparison.</p>
                    )}
                    <Link className="history-open-link" to="/reports">Open Reports / History <ArrowRight size={15} /></Link>
                  </div>
                )}

                {activeResultTab === 'weather' && (
                  weatherLoading ? (
                    <div className="result-tab-loading"><LoaderCircle className="satellite-spinner" size={18} /> Loading weather...</div>
                  ) : weather ? (
                    <div className="weather-result">
                      <div className="weather-hero">
                        <CloudRain size={35} />
                        <div><span>{weatherLabel(weather.weatherCode)}</span><strong>{weather.temperature ?? '—'}°C</strong><small>{weather.location}</small></div>
                      </div>
                      <div className="weather-metric-grid">
                        <div><Droplets size={18} /><span>Humidity</span><strong>{weather.humidity ?? '—'}%</strong></div>
                        <div><CloudRain size={18} /><span>Rainfall</span><strong>{weather.precipitation ?? '—'} mm</strong></div>
                        <div><Wind size={18} /><span>Wind speed</span><strong>{weather.windSpeed ?? '—'} km/h</strong></div>
                        <div><Thermometer size={18} /><span>Observed</span><strong>{weather.observedAt?.split('T')[1] || 'Now'}</strong></div>
                      </div>
                      <p className="result-data-note">Weather is live contextual information from Open-Meteo and is not an input to this RGB model.</p>
                    </div>
                  ) : (
                    <div className="result-tab-loading">Weather is currently unavailable.</div>
                  )
                )}

                {activeResultTab === 'sources' && (
                  <div className="sources-result">
                    <p>Use these open or free-data sources to verify results or extend the RGB workflow with dated/multispectral information.</p>
                    <div className="sources-link-grid">
                      <a href="https://www.openstreetmap.org/" target="_blank" rel="noreferrer">OpenStreetMap <ArrowRight size={14} /></a>
                      <a href="https://dataspace.copernicus.eu/" target="_blank" rel="noreferrer">Copernicus Data Space <ArrowRight size={14} /></a>
                      <a href="https://www.usgs.gov/landsat-missions/landsat-data-access" target="_blank" rel="noreferrer">USGS Landsat <ArrowRight size={14} /></a>
                      <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo <ArrowRight size={14} /></a>
                      <a href={analysis.model.source || 'https://github.com/sebastianbahr/OpenEarthMap'} target="_blank" rel="noreferrer">OpenEarthMap <ArrowRight size={14} /></a>
                    </div>
                  </div>
                )}

                <div className="result-download-row no-print">
                  <button type="button" onClick={() => generateAnalysisPdf(activeHistoryRecord, user?.email || '')}>
                    <FileDown size={16} /> Generate PDF report
                  </button>
                  {analysis.overlayImage && (
                    <a href={analysis.overlayImage} download="agriterrain-detection-mask.png">
                      <Download size={16} /> Mask PNG
                    </a>
                  )}
                </div>
              </>
            )}
          </article>

          <article className="satellite-panel field-recommendation-card">
            <Focus size={21} />
            <div>
              <strong>Accuracy-first selection</strong>
              <p>For individual houses and small ponds, keep estimated detail near 0.8 m/pixel or better. The backend also uses stricter water and building precision filters to reduce false positives.</p>
            </div>
          </article>
        </aside>
      </section>

      {analysis && overlayBounds && (
        <section className="satellite-print-summary">
          <div><BrainCircuit size={24} /><span><strong>AgriTerrain AI analysis</strong><small>{analysis.model.name}</small></span></div>
          <p>{analysis.location} · {analysis.areaHectares.toFixed(2)} ha</p>
        </section>
      )}
    </WorkspaceShell>
  )
}

export default SatelliteAnalysis
