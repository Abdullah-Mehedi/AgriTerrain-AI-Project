import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  History,
  MapPin,
  RefreshCw,
  Satellite,
  Trash2,
} from 'lucide-react'
import {
  Link,
  useNavigate,
  useParams,
} from 'react-router-dom'
import WorkspaceShell from '../components/WorkspaceShell'
import ComparisonPreview from '../components/ComparisonPreview'
import ReportDetailsModal from '../components/ReportDetailsModal'
import { useAuth } from '../context/auth-context'
import {
  boundarySignature,
  deleteAnalysisHistoryRecord,
  getAnalysisHistory,
} from '../services/history'
import {
  removeComparisonsForRecord,
  saveComparisonReport,
} from '../services/comparisonHistory'
import { generateAnalysisPdf } from '../services/reportPdf'
import './HistoricalAnalysis.css'

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

function coordinateLabel(record) {
  const latitude =
    Number(record?.coordinates?.[0])

  const longitude =
    Number(record?.coordinates?.[1])

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return '—'
  }

  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
}


function comparisonTimeLabel(value) {
  if (!value) return 'Unknown time'

  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function buildComparisonTitle(records) {
  if (!Array.isArray(records) || !records.length) {
    return 'Report comparison'
  }

  const locations = [
    ...new Set(
      records.map(
        (record) =>
          String(record?.location || 'Unknown location'),
      ),
    ),
  ]

  if (records.length === 2) {
    if (locations.length === 1) {
      return `${locations[0]} · ${comparisonTimeLabel(
        records[0].createdAt,
      )} vs ${comparisonTimeLabel(
        records[1].createdAt,
      )}`
    }

    return `${records[0].location} vs ${records[1].location}`
  }

  if (locations.length === 1) {
    return `${locations[0]} · ${records.length}-report comparison`
  }

  return `${records.length}-report comparison · ${locations.length} locations`
}

function HistoricalAnalysis() {
  const { user } = useAuth()
  const { recordId } = useParams()
  const navigate = useNavigate()

  const [history, setHistory] =
    useState(
      () => getAnalysisHistory(user?.id),
    )

  const baseRecord =
    history.find(
      (record) =>
        record.id === recordId,
    )

  const signature =
    boundarySignature(
      baseRecord?.boundary,
    )

  const runs = useMemo(() => {
    if (!signature) return []

    return history
      .filter(
        (record) =>
          boundarySignature(
            record.boundary,
          ) === signature,
      )
      .sort(
        (a, b) =>
          new Date(
            a.createdAt || 0,
          ).getTime() -
          new Date(
            b.createdAt || 0,
          ).getTime(),
      )
  }, [history, signature])

  const [selectedRecord, setSelectedRecord] =
    useState(null)

  const [compareMode, setCompareMode] =
    useState(false)

  const [selectedIds, setSelectedIds] =
    useState([])

  const [
    comparisonPreview,
    setComparisonPreview,
  ] = useState(null)

  if (!baseRecord || !signature) {
    return (
      <WorkspaceShell
        title="Historical Analysis Report"
        description="Repeated analysis for one exact saved land boundary."
      >
        <section className="historical-empty">
          <History size={36} />

          <h2>
            Historical boundary unavailable
          </h2>

          <p>
            This report no longer contains
            a reusable saved boundary.
          </p>

          <Link to="/reports">
            <ArrowLeft size={16} />
            Back to Reports
          </Link>
        </section>
      </WorkspaceShell>
    )
  }

  function toggleSelected(id) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter(
            (value) => value !== id,
          )
        : [...current, id],
    )
  }

  function finishCompare() {
    if (selectedIds.length < 2) return

    const selectedRuns =
      runs.filter((record) =>
        selectedIds.includes(record.id),
      )

    if (selectedRuns.length < 2) return

    const { record: comparison } =
      saveComparisonReport(
        user?.id,
        {
          type: 'historical',

          title:
            buildComparisonTitle(selectedRuns),

          location:
            baseRecord.location,

          boundarySignature:
            signature,

          recordIds:
            selectedRuns.map(
              (record) => record.id,
            ),
        },
      )

    setComparisonPreview({
      comparison,
      records: selectedRuns,
    })

    setCompareMode(false)
    setSelectedIds([])
  }

  function removeRun(record) {
    if (
      !window.confirm(
        'Delete this saved historical analysis?',
      )
    ) {
      return
    }

    const next =
      deleteAnalysisHistoryRecord(
        user?.id,
        record.id,
      )

    removeComparisonsForRecord(
      user?.id,
      record.id,
    )

    setHistory(next)

    setSelectedIds((current) =>
      current.filter(
        (id) => id !== record.id,
      ),
    )

    if (
      selectedRecord?.id === record.id
    ) {
      setSelectedRecord(null)
    }

    if (record.id === recordId) {
      const replacement =
        next.find(
          (item) =>
            boundarySignature(
              item.boundary,
            ) === signature,
        )

      if (replacement) {
        navigate(
          `/reports/history/${encodeURIComponent(
            replacement.id,
          )}`,
          { replace: true },
        )
      } else {
        navigate('/reports')
      }
    }
  }

  function analyzeAgain() {
    navigate(
      '/satellite-analysis',
      {
        state: {
          historicalReplay: {
            sourceRecordId:
              baseRecord.id,

            location:
              baseRecord.location,

            coordinates:
              baseRecord.coordinates,

            boundary:
              baseRecord.boundary,

            areaHectares:
              baseRecord.areaHectares,

            boundarySignature:
              signature,

            returnPath:
              `/reports/history/${encodeURIComponent(
                baseRecord.id,
              )}`,
          },
        },
      },
    )
  }

  return (
    <WorkspaceShell
      title="Historical Analysis Report"
      description="Repeat, review and compare analyses for one exact saved land boundary."
      headerActions={
        <button
          className="historical-back-link"
          type="button"
          onClick={() =>
            navigate(
              '/reports',
              {
                state: {
                  reopenCompareRecordId:
                    baseRecord.id,
                },
              },
            )
          }
        >
          <ArrowLeft size={16} />
          Return
        </button>
      }
    >
      <section className="historical-summary-strip">
        <span className="historical-summary-icon">
          <MapPin size={27} />
        </span>

        <div className="historical-summary-main">
          <strong>
            {baseRecord.location}
          </strong>

          <p>
            {coordinateLabel(baseRecord)}
          </p>
        </div>

        <div className="historical-summary-metrics">
          <div>
            <small>Selected area</small>
            <strong>
              {number(
                baseRecord.areaHectares,
                2,
              )} ha
            </strong>
          </div>

          <div>
            <small>Boundary points</small>
            <strong>
              {baseRecord.boundary.length}
            </strong>
          </div>

          <div>
            <small>Historical runs</small>
            <strong>{runs.length}</strong>
          </div>
        </div>
      </section>

      <section className="historical-timeline-heading">
        <div>
          <h2>Analysis timeline</h2>

          <p>
            Each row below uses this exact saved polygon.
          </p>
        </div>

        <div>
          {!compareMode ? (
            <button
              type="button"
              disabled={runs.length < 2}
              onClick={() => {
                setCompareMode(true)
                setSelectedIds([])
              }}
            >
              <History size={16} />
              Compare
            </button>
          ) : (
            <>
              <button
                className="historical-cancel"
                type="button"
                onClick={() => {
                  setCompareMode(false)
                  setSelectedIds([])
                }}
              >
                Cancel
              </button>

              <button
                className={
                  selectedIds.length >= 2
                    ? 'historical-done ready'
                    : 'historical-done'
                }
                type="button"
                disabled={
                  selectedIds.length < 2
                }
                onClick={finishCompare}
              >
                <Check size={15} />
                Done
              </button>
            </>
          )}
        </div>
      </section>

      <section className="historical-rows">
        {runs.map((record, index) => {
          const selected =
            selectedIds.includes(record.id)

          return (
            <article
              className={
                selected
                  ? 'historical-row selected'
                  : 'historical-row'
              }
              key={record.id}
            >
              <span className="historical-row-number">
                {index + 1}
              </span>

              <div>
                <small>
                  {record.location}
                </small>

                <strong>
                  {formatDate(
                    record.createdAt,
                  )}
                </strong>
              </div>

              <div className="historical-row-metrics">
                <span>
                  {number(
                    record.areaHectares,
                    2,
                  )} ha
                </span>

                <span>
                  {number(
                    record.meanModelCertainty,
                  )}% certainty
                </span>
              </div>

              {compareMode ? (
                <button
                  className={
                    selected
                      ? 'historical-select selected'
                      : 'historical-select'
                  }
                  type="button"
                  onClick={() =>
                    toggleSelected(record.id)
                  }
                >
                  {selected && (
                    <Check size={14} />
                  )}

                  {selected
                    ? 'Selected'
                    : 'Select'}
                </button>
              ) : (
                <div className="historical-row-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedRecord(
                        record,
                      )
                    }
                  >
                    View
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      generateAnalysisPdf(
                        record,
                        user?.email || '',
                        user?.id || '',
                      )
                    }
                  >
                    <Download size={14} />
                    PDF
                  </button>

                  <button
                    className="historical-delete"
                    type="button"
                    onClick={() =>
                      removeRun(record)
                    }
                    aria-label="Delete historical analysis"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </article>
          )
        })}
      </section>

      <section className="historical-analyze-again">
        <span>
          <RefreshCw size={22} />
        </span>

        <div>
          <h2>
            Analyze this exact area again
          </h2>

          <p>
            Reuse the same locked polygon.
            Detection mode can still be selected normally.
          </p>
        </div>

        <button
          type="button"
          onClick={analyzeAgain}
        >
          <Satellite size={16} />
          Analyze again
          <ArrowRight size={15} />
        </button>
      </section>

      {selectedRecord && (
        <ReportDetailsModal
          record={selectedRecord}
          userId={user?.id || ''}
          accountLabel={user?.email || ''}
          onClose={() =>
            setSelectedRecord(null)
          }
        />
      )}

      {comparisonPreview && (
        <ComparisonPreview
          comparison={
            comparisonPreview.comparison
          }
          records={
            comparisonPreview.records
          }
          userId={user?.id || ''}
          accountLabel={user?.email || ''}
          onClose={() =>
            setComparisonPreview(null)
          }
        />
      )}
    </WorkspaceShell>
  )
}

export default HistoricalAnalysis
