import { useEffect, useMemo, useState } from 'react'
import {
  Download,
  History,
  Leaf,
  X,
} from 'lucide-react'
import { buildRecommendations } from '../services/history'
import { generateAnalysisPdf } from '../services/reportPdf'
import { getReportVisuals } from '../services/reportVisuals'
import './ReportDetailsModal.css'

function formatDate(value) {
  if (!value) return 'Unknown date'
  return new Date(value).toLocaleString()
}

function number(value, digits = 1) {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? parsed.toFixed(digits)
    : '—'
}

function ReportDetailsModal({
  record,
  userId = '',
  accountLabel = '',
  onClose,
  onCompare,
}) {
  const [visuals, setVisuals] =
    useState(null)

  const [visualError, setVisualError] =
    useState('')

  const recommendations = useMemo(
    () => buildRecommendations(record),
    [record],
  )

  useEffect(() => {
    let active = true

    setVisuals(null)
    setVisualError('')

    if (!record) return undefined

    getReportVisuals(
      userId,
      record,
    )
      .then((result) => {
        if (active) setVisuals(result)
      })
      .catch((error) => {
        if (active) {
          setVisualError(
            error?.message ||
            'Before/after satellite images are unavailable.',
          )
        }
      })

    return () => {
      active = false
    }
  }, [record, userId])

  if (!record) return null

  return (
    <div
      className="report-details-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Saved analysis details"
    >
      <button
        className="report-details-backdrop"
        type="button"
        aria-label="Close report"
        onClick={onClose}
      />

      <section>
        <header className="report-details-header">
          <div>
            <span>Saved analysis</span>
            <h2>{record.location}</h2>
            <p>{formatDate(record.createdAt)}</p>
          </div>

          <button
            type="button"
            aria-label="Close report"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="report-details-body">
          <section className="report-actual-images">
            {visuals ? (
              <>
                <figure>
                  <img
                    src={visuals.beforeImage}
                    alt="Satellite area before detection"
                  />
                  <figcaption>
                    Before detection
                  </figcaption>
                </figure>

                <figure>
                  <img
                    src={visuals.afterImage}
                    alt="Satellite area after detection"
                  />
                  <figcaption>
                    After detection
                  </figcaption>
                </figure>
              </>
            ) : (
              <div className="report-images-loading">
                {visualError ||
                  'Preparing actual before/after satellite images...'}
              </div>
            )}
          </section>

          <div className="report-details-stats">
            <article>
              <small>Selected area</small>
              <strong>
                {number(record.areaHectares, 2)} ha
              </strong>
            </article>

            <article>
              <small>Mean certainty</small>
              <strong>
                {number(record.meanModelCertainty)}%
              </strong>
            </article>

            <article>
              <small>User threshold</small>
              <strong>
                {number(
                  record.confidenceThreshold,
                  0,
                )}%
              </strong>
            </article>
          </div>

          <section className="report-details-block">
            <h3>Land-cover result</h3>

            <div className="report-details-result-table">
              <div>
                <span>Crop</span>
                <strong>
                  {record.counts?.crop || 0} regions
                </strong>
                <b>
                  {number(record.coverage?.crop)}%
                </b>
              </div>

              <div>
                <span>Water</span>
                <strong>
                  {record.counts?.water || 0} regions
                </strong>
                <b>
                  {number(record.coverage?.water)}%
                </b>
              </div>

              <div>
                <span>Building</span>
                <strong>
                  {record.counts?.building || 0} regions
                </strong>
                <b>
                  {number(record.coverage?.building)}%
                </b>
              </div>
            </div>
          </section>

          <section className="report-details-science">
            <Leaf size={18} />

            <p>
              <strong>Crop health / NDVI status</strong>

              <span>
                Not calculated from the current RGB image.
                Multispectral bands are required.
              </span>
            </p>
          </section>

          <section className="report-details-block">
            <h3>Recommendations</h3>

            <ul>
              {recommendations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="report-details-actions">
          <button
            type="button"
            onClick={() =>
              generateAnalysisPdf(
                record,
                accountLabel,
                userId,
              )
            }
          >
            <Download size={16} />
            Generate PDF
          </button>

          {onCompare && (
            <button
              className="report-details-secondary"
              type="button"
              onClick={() => onCompare(record)}
            >
              <History size={16} />
              Compare
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

export default ReportDetailsModal
