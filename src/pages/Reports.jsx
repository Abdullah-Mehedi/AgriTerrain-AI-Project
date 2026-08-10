import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Download,
  Droplets,
  FileDown,
  FileText,
  Filter,
  Home,
  Leaf,
  MapPin,
  Search,
  Satellite,
  Trash2,
  X,
} from 'lucide-react'
import WorkspaceShell from '../components/WorkspaceShell'
import { useAuth } from '../context/auth-context'
import {
  buildRecommendations,
  clearAnalysisHistory,
  deleteAnalysisHistoryRecord,
  findPreviousComparableRecord,
  getAnalysisHistory,
} from '../services/history'
import { generateAnalysisPdf } from '../services/reportPdf'
import './Reports.css'

function formatDate(value) {
  if (!value) return 'Unknown date'
  return new Date(value).toLocaleString()
}

function number(value, digits = 1) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—'
}

function changeLabel(current, previous) {
  const delta = Number(current || 0) - Number(previous || 0)
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp`
}

function Reports() {
  const { user } = useAuth()
  const [history, setHistory] = useState(() => getAnalysisHistory(user?.id))
  const [query, setQuery] = useState('')
  const [dateRange, setDateRange] = useState('all')
  const [selectedRecord, setSelectedRecord] = useState(null)

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase()
    const now = Date.now()
    const maxAge = dateRange === '7' ? 7 : dateRange === '30' ? 30 : null

    return history.filter((record) => {
      const matchesSearch = !search || String(record.location || '').toLowerCase().includes(search)
      if (!matchesSearch) return false
      if (!maxAge) return true
      const time = new Date(record.createdAt).getTime()
      return Number.isFinite(time) && now - time <= maxAge * 24 * 60 * 60 * 1000
    })
  }, [dateRange, history, query])

  const totals = useMemo(
    () => history.reduce(
      (summary, record) => ({
        crop: summary.crop + Number(record.counts?.crop || 0),
        water: summary.water + Number(record.counts?.water || 0),
        building: summary.building + Number(record.counts?.building || 0),
      }),
      { crop: 0, water: 0, building: 0 },
    ),
    [history],
  )

  const previousRecord = selectedRecord
    ? findPreviousComparableRecord(history, selectedRecord)
    : null
  const recommendations = selectedRecord ? buildRecommendations(selectedRecord) : []

  function removeRecord(recordId) {
    setHistory(deleteAnalysisHistoryRecord(user?.id, recordId))
    if (selectedRecord?.id === recordId) setSelectedRecord(null)
  }

  function clearAll() {
    if (!history.length) return
    if (!window.confirm('Clear all locally saved AgriTerrain analysis history for this account?')) return
    setHistory(clearAnalysisHistory(user?.id))
    setSelectedRecord(null)
  }

  function exportRecord(record) {
    generateAnalysisPdf(record, user?.email || '')
  }

  return (
    <WorkspaceShell
      title="Reports / History"
      description="Review saved searches, compare repeated locations, and generate analysis reports."
      headerActions={
        <Link className="reports-header-cta no-print" to="/satellite-analysis">
          <Satellite size={16} /> New analysis
        </Link>
      }
    >
      <section className="reports-summary-grid">
        <article><span><FileText size={20} /></span><div><small>Saved analyses</small><strong>{history.length}</strong></div></article>
        <article><span><Leaf size={20} /></span><div><small>Crop regions</small><strong>{totals.crop}</strong></div></article>
        <article><span><Droplets size={20} /></span><div><small>Water regions</small><strong>{totals.water}</strong></div></article>
        <article><span><Home size={20} /></span><div><small>Building regions</small><strong>{totals.building}</strong></div></article>
      </section>

      <section className="reports-toolbar no-print">
        <div className="reports-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by location..." aria-label="Filter reports by location" />
        </div>
        <label className="reports-date-filter">
          <Filter size={16} />
          <select value={dateRange} onChange={(event) => setDateRange(event.target.value)} aria-label="Filter reports by date">
            <option value="all">All dates</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <button className="reports-clear-button" type="button" onClick={clearAll} disabled={!history.length}>
          <Trash2 size={16} /> Clear history
        </button>
      </section>

      <section className="reports-local-note">
        <FileText size={18} />
        <p><strong>Browser-local history</strong><span>Saved records are kept for the signed-in account in this browser. Large overlay images are not duplicated in history, which keeps storage smaller.</span></p>
      </section>

      {filtered.length ? (
        <section className="reports-card-grid">
          {filtered.map((record) => (
            <article className="report-card" key={record.id}>
              <header>
                <div className="report-location-icon"><MapPin size={20} /></div>
                <div><span>Satellite analysis</span><h2>{record.location}</h2><p><CalendarDays size={14} /> {formatDate(record.createdAt)}</p></div>
                <strong>{number(record.areaHectares, 2)} ha</strong>
              </header>

              <div className="report-count-grid">
                <div><small>Crop</small><strong>{record.counts?.crop || 0}</strong><span>{number(record.coverage?.crop)}%</span></div>
                <div><small>Water</small><strong>{record.counts?.water || 0}</strong><span>{number(record.coverage?.water)}%</span></div>
                <div><small>Buildings</small><strong>{record.counts?.building || 0}</strong><span>{number(record.coverage?.building)}%</span></div>
              </div>

              <div className="report-evidence-line">
                <BarChart3 size={15} />
                <span>{number(record.meanModelCertainty)}% mean model certainty</span>
              </div>

              <footer>
                <button type="button" onClick={() => setSelectedRecord(record)}>View / compare <ArrowRight size={15} /></button>
                <button type="button" onClick={() => exportRecord(record)}><FileDown size={15} /> Generate PDF</button>
                <button className="report-delete" type="button" onClick={() => removeRecord(record.id)} aria-label={`Delete report for ${record.location}`}><Trash2 size={15} /></button>
              </footer>
            </article>
          ))}
        </section>
      ) : (
        <section className="reports-empty-state">
          <span><FileText size={34} /></span>
          <h2>{history.length ? 'No reports match these filters' : 'No saved analyses yet'}</h2>
          <p>{history.length ? 'Change the location or date filter to show more records.' : 'Run a real satellite analysis. Completed results will appear here automatically.'}</p>
          <Link to="/satellite-analysis">Open Satellite Analysis <ArrowRight size={16} /></Link>
        </section>
      )}

      {selectedRecord && (
        <div className="reports-modal" role="dialog" aria-modal="true" aria-label="Analysis report details">
          <button className="reports-modal-backdrop" type="button" aria-label="Close report details" onClick={() => setSelectedRecord(null)} />
          <section>
            <header className="reports-modal-header">
              <div><span>Saved analysis</span><h2>{selectedRecord.location}</h2><p>{formatDate(selectedRecord.createdAt)}</p></div>
              <button type="button" aria-label="Close report details" onClick={() => setSelectedRecord(null)}><X size={19} /></button>
            </header>

            <div className="reports-modal-body">
              <div className="reports-detail-stats">
                <article><small>Selected area</small><strong>{number(selectedRecord.areaHectares, 2)} ha</strong></article>
                <article><small>Mean certainty</small><strong>{number(selectedRecord.meanModelCertainty)}%</strong></article>
                <article><small>User threshold</small><strong>{number(selectedRecord.confidenceThreshold, 0)}%</strong></article>
              </div>

              <section className="reports-section-block">
                <h3>Land-cover result</h3>
                <div className="reports-result-table">
                  <div><span>Crop</span><strong>{selectedRecord.counts?.crop || 0} regions</strong><b>{number(selectedRecord.coverage?.crop)}%</b></div>
                  <div><span>Water</span><strong>{selectedRecord.counts?.water || 0} regions</strong><b>{number(selectedRecord.coverage?.water)}%</b></div>
                  <div><span>Building</span><strong>{selectedRecord.counts?.building || 0} regions</strong><b>{number(selectedRecord.coverage?.building)}%</b></div>
                </div>
              </section>

              <section className="reports-science-note">
                <Leaf size={18} />
                <p><strong>Crop health / NDVI status</strong><span>Not calculated from the current RGB image. Multispectral bands are required, so this page intentionally does not invent a vegetation score.</span></p>
              </section>

              <section className="reports-section-block">
                <h3>Historical comparison</h3>
                {previousRecord ? (
                  <>
                    <p className="reports-compare-caption">Compared with {formatDate(previousRecord.createdAt)} for the exact same saved location name.</p>
                    <div className="reports-compare-grid">
                      <div><small>Crop cover change</small><strong>{changeLabel(selectedRecord.coverage?.crop, previousRecord.coverage?.crop)}</strong></div>
                      <div><small>Water cover change</small><strong>{changeLabel(selectedRecord.coverage?.water, previousRecord.coverage?.water)}</strong></div>
                      <div><small>Built cover change</small><strong>{changeLabel(selectedRecord.coverage?.building, previousRecord.coverage?.building)}</strong></div>
                    </div>
                    <p className="reports-limit-note">Analysis timestamps are not guaranteed imagery capture dates. Use imagery metadata or dated satellite products for a scientific time-series comparison.</p>
                  </>
                ) : (
                  <p className="reports-limit-note">No earlier saved result uses this exact location name yet. Analyze the same place again later to enable a basic comparison.</p>
                )}
              </section>

              <section className="reports-section-block">
                <h3>Recommendations</h3>
                <ul>{recommendations.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>

              <section className="reports-section-block">
                <h3>Source links</h3>
                <div className="reports-source-grid">
                  <a href="https://www.openstreetmap.org/" target="_blank" rel="noreferrer">OpenStreetMap <ArrowRight size={14} /></a>
                  <a href="https://dataspace.copernicus.eu/" target="_blank" rel="noreferrer">Copernicus Data Space <ArrowRight size={14} /></a>
                  <a href="https://www.usgs.gov/landsat-missions/landsat-data-access" target="_blank" rel="noreferrer">USGS Landsat <ArrowRight size={14} /></a>
                  <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo <ArrowRight size={14} /></a>
                  <a href={selectedRecord.model?.source || 'https://github.com/sebastianbahr/OpenEarthMap'} target="_blank" rel="noreferrer">OpenEarthMap <ArrowRight size={14} /></a>
                </div>
              </section>
            </div>

            <footer className="reports-modal-actions">
              <button type="button" onClick={() => exportRecord(selectedRecord)}><Download size={16} /> Generate PDF</button>
              <Link to="/satellite-analysis">New analysis <ArrowRight size={16} /></Link>
            </footer>
          </section>
        </div>
      )}
    </WorkspaceShell>
  )
}

export default Reports
