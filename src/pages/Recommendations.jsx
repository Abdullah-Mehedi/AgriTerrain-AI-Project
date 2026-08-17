import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Droplets,
  Home,
  Lightbulb,
  Map,
  Satellite,
} from 'lucide-react'
import WorkspaceShell from '../components/WorkspaceShell'
import { useAuth } from '../context/auth-context'
import {
  buildRecommendations,
  getAnalysisHistory,
} from '../services/history'
import './Recommendations.css'

function formatDate(value) {
  if (!value) return 'Unknown date'
  return new Date(value).toLocaleString()
}

function number(value, digits = 1) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—'
}

function Recommendations() {
  const { user } = useAuth()

  const history = useMemo(
    () => getAnalysisHistory(user?.id),
    [user?.id],
  )

  const [selectedId, setSelectedId] = useState('')

  const selectedRecord =
    history.find((record) => record.id === selectedId) ||
    history[0] ||
    null

  const recommendations = useMemo(
    () => buildRecommendations(selectedRecord),
    [selectedRecord],
  )

  return (
    <WorkspaceShell
      title="Recommendations"
      description="Review practical guidance based on saved analysis evidence."
      headerActions={
        <Link
          className="recommendations-header-action"
          to="/satellite-analysis"
        >
          <Satellite size={16} />
          New analysis
        </Link>
      }
    >
      <section className="recommendations-hero">
        <div>
          <span>Evidence-based guidance</span>
          <h2>Review the latest model output with its limitations.</h2>
          <p>
            Recommendations use saved land-cover results and available
            environmental context. Unsupported crop-health or hazard values
            are never invented.
          </p>
        </div>

        <div className="recommendations-hero-count">
          <Lightbulb size={25} />
          <strong>{recommendations.length}</strong>
          <small>Guidance items</small>
        </div>
      </section>

      {selectedRecord ? (
        <>
          <section className="recommendations-selector">
            <div>
              <label htmlFor="recommendation-record">
                Saved analysis
              </label>

              <select
                id="recommendation-record"
                value={selectedRecord.id}
                onChange={(event) =>
                  setSelectedId(event.target.value)
                }
              >
                {history.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.location} · {formatDate(record.createdAt)}
                  </option>
                ))}
              </select>
            </div>

            <p>
              {number(selectedRecord.areaHectares, 2)} ha ·{' '}
              {number(selectedRecord.meanModelCertainty)}% certainty
            </p>
          </section>

          <section className="recommendations-evidence-grid">
            <article>
              <span className="evidence-crop"><Map size={18} /></span>
              <small>Crop cover</small>
              <strong>{number(selectedRecord.coverage?.crop)}%</strong>
            </article>

            <article>
              <span className="evidence-water"><Droplets size={18} /></span>
              <small>Water cover</small>
              <strong>{number(selectedRecord.coverage?.water)}%</strong>
            </article>

            <article>
              <span className="evidence-building"><Home size={18} /></span>
              <small>Building cover</small>
              <strong>{number(selectedRecord.coverage?.building)}%</strong>
            </article>

            <article>
              <span className="evidence-certainty"><BarChart3 size={18} /></span>
              <small>Model certainty</small>
              <strong>{number(selectedRecord.meanModelCertainty)}%</strong>
            </article>
          </section>

          <section className="recommendations-list">
            <header>
              <span>Analysis guidance</span>
              <h2>{selectedRecord.location}</h2>
            </header>

            {recommendations.map((item, index) => (
              <article key={`${index}-${item}`}>
                <span>{index + 1}</span>
                <p>{item}</p>
              </article>
            ))}
          </section>

          <section className="recommendations-limit">
            <AlertTriangle size={20} />
            <div>
              <strong>Scientific limitation</strong>
              <p>
                RGB imagery alone does not provide NDVI or NDWI, and current
                weather observations are not a flood- or drought-risk model.
              </p>
            </div>
          </section>
        </>
      ) : (
        <section className="recommendations-empty">
          <Lightbulb size={34} />
          <h2>No saved analysis yet</h2>
          <p>
            Complete a satellite analysis first to generate evidence-based
            recommendations.
          </p>
          <Link to="/satellite-analysis">
            Start Satellite Analysis
            <ArrowRight size={16} />
          </Link>
        </section>
      )}
    </WorkspaceShell>
  )
}

export default Recommendations
