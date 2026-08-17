import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  Download,
  Droplets,
  FileDown,
  FileText,
  Filter,
  History,
  Home,
  Leaf,
  MapPin,
  Search,
  Satellite,
  Trash2,
  X,
} from 'lucide-react'
import WorkspaceShell from '../components/WorkspaceShell'
import ComparisonPreview from '../components/ComparisonPreview'
import ReportDetailsModal from '../components/ReportDetailsModal'
import { useAuth } from '../context/auth-context'
import {
  clearAnalysisHistory,
  deleteAnalysisHistoryRecord,
  getAnalysisHistory,
} from '../services/history'
import {
  clearComparisonHistory,
  deleteComparisonReport,
  getComparisonHistory,
  removeComparisonsForRecord,
  saveComparisonReport,
} from '../services/comparisonHistory'
import { generateAnalysisPdf } from '../services/reportPdf'
import { generateComparisonPdf } from '../services/comparisonPdf'
import './Reports.css'

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



function shortComparisonDate(value) {
  if (!value) return 'Unknown time'

  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function ComparisonArchiveIdentity({
  comparison,
  records,
  historical = false,
}) {
  const label = historical
    ? 'Historical analysis report'
    : 'Report comparison'

  if (records.length === 2) {
    return (
      <div className="comparison-archive-identity">
        <small>
          {label} · {shortComparisonDate(comparison.createdAt)}
        </small>

        <div className="comparison-archive-pair">
          <div>
            <strong>{records[0].location}</strong>
            <span>
              {shortComparisonDate(records[0].createdAt)}
            </span>
          </div>

          <b>vs</b>

          <div>
            <strong>{records[1].location}</strong>
            <span>
              {shortComparisonDate(records[1].createdAt)}
            </span>
          </div>
        </div>

        <p>2 saved reports</p>
      </div>
    )
  }

  return (
    <div className="comparison-archive-identity">
      <small>
        {label} · {shortComparisonDate(comparison.createdAt)}
      </small>

      <h2>{buildComparisonTitle(records)}</h2>

      <p>
        {records.length} saved reports
      </p>
    </div>
  )
}

function Reports() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const routeLocation = useLocation()

  const [history, setHistory] =
    useState(
      () => getAnalysisHistory(user?.id),
    )

  const [comparisons, setComparisons] =
    useState(
      () => getComparisonHistory(user?.id),
    )

  const [query, setQuery] = useState('')
  const [dateRange, setDateRange] =
    useState('all')

  const [activeTab, setActiveTab] =
    useState('reports')

  const [selectedRecord, setSelectedRecord] =
    useState(null)

  const [
    compareChoiceRecord,
    setCompareChoiceRecord,
  ] = useState(null)

  const [
    compareSelecting,
    setCompareSelecting,
  ] = useState(false)

  const [selectedIds, setSelectedIds] =
    useState([])

  const [
    comparisonPreview,
    setComparisonPreview,
  ] = useState(null)

  const [
    compareOriginRecordId,
    setCompareOriginRecordId,
  ] = useState('')

  useEffect(() => {
    const reopenRecordId =
      routeLocation.state?.reopenCompareRecordId

    if (!reopenRecordId) return

    const record =
      history.find(
        (item) => item.id === reopenRecordId,
      )

    if (!record) return

    setActiveTab('reports')
    setCompareSelecting(false)
    setSelectedIds([])
    setCompareOriginRecordId(record.id)
    setCompareChoiceRecord(record)

    navigate(
      '/reports',
      {
        replace: true,
        state: null,
      },
    )
  }, [
    history,
    navigate,
    routeLocation.state,
  ])

  const filtered = useMemo(() => {
    const search =
      query.trim().toLowerCase()

    const now = Date.now()

    const maxAge =
      dateRange === '7'
        ? 7
        : dateRange === '30'
          ? 30
          : null

    return history.filter((record) => {
      const matchesSearch =
        !search ||
        String(record.location || '')
          .toLowerCase()
          .includes(search)

      if (!matchesSearch) return false
      if (!maxAge) return true

      const time =
        new Date(record.createdAt).getTime()

      return (
        Number.isFinite(time) &&
        now - time <=
          maxAge * 24 * 60 * 60 * 1000
      )
    })
  }, [dateRange, history, query])

  const totals = useMemo(
    () =>
      history.reduce(
        (summary, record) => ({
          crop:
            summary.crop +
            Number(record.counts?.crop || 0),

          water:
            summary.water +
            Number(record.counts?.water || 0),

          building:
            summary.building +
            Number(record.counts?.building || 0),
        }),
        {
          crop: 0,
          water: 0,
          building: 0,
        },
      ),
    [history],
  )

  const generalComparisons = useMemo(
    () =>
      comparisons.filter(
        (comparison) =>
          comparison.type !== 'historical',
      ),
    [comparisons],
  )

  const historicalComparisons = useMemo(
    () =>
      comparisons.filter(
        (comparison) =>
          comparison.type === 'historical',
      ),
    [comparisons],
  )


  const selectedCount =
    selectedIds.length

  function removeRecord(recordId) {
    setHistory(
      deleteAnalysisHistoryRecord(
        user?.id,
        recordId,
      ),
    )

    setComparisons(
      removeComparisonsForRecord(
        user?.id,
        recordId,
      ),
    )

    if (
      selectedRecord?.id === recordId
    ) {
      setSelectedRecord(null)
    }

    setSelectedIds((current) =>
      current.filter(
        (id) => id !== recordId,
      ),
    )
  }

  function clearAll() {
    if (
      !history.length &&
      !comparisons.length
    ) {
      return
    }

    if (
      !window.confirm(
        'Clear all locally saved AgriTerrain analysis and comparison history for this account?',
      )
    ) {
      return
    }

    setHistory(
      clearAnalysisHistory(user?.id),
    )

    setComparisons(
      clearComparisonHistory(user?.id),
    )

    setSelectedRecord(null)
    setSelectedIds([])
    setCompareSelecting(false)
  }

  function exportRecord(record) {
    generateAnalysisPdf(
      record,
      user?.email || '',
      user?.id || '',
    )
  }

  function beginCompare(record) {
    setCompareOriginRecordId(record?.id || '')
    setCompareChoiceRecord(null)
    setCompareSelecting(true)

    setSelectedIds(
      record?.id
        ? [record.id]
        : [],
    )

    setActiveTab('reports')
  }

  function toggleSelected(recordId) {
    setSelectedIds((current) =>
      current.includes(recordId)
        ? current.filter(
            (id) => id !== recordId,
          )
        : [...current, recordId],
    )
  }

  function cancelCompare() {
    setCompareSelecting(false)
    setSelectedIds([])
  }


  function returnToCompareOptions() {
    const record =
      history.find(
        (item) =>
          item.id === compareOriginRecordId,
      )

    setCompareSelecting(false)
    setSelectedIds([])

    if (record) {
      setCompareChoiceRecord(record)
    }
  }

  function finishGeneralComparison() {
    if (selectedIds.length < 2) return

    const records =
      history.filter((record) =>
        selectedIds.includes(record.id),
      )

    if (records.length < 2) return

    const locations = [
      ...new Set(
        records.map(
          (record) => record.location,
        ),
      ),
    ]

    const {
      record: comparison,
      history: next,
    } = saveComparisonReport(
      user?.id,
      {
        type: 'general',

        title:
          buildComparisonTitle(records),

        location:
          locations.length === 1
            ? locations[0]
            : 'Multiple locations',

        recordIds:
          records.map(
            (record) => record.id,
          ),
      },
    )

    setComparisons(next)

    setComparisonPreview({
      comparison,
      records,
    })

    setCompareSelecting(false)
    setSelectedIds([])
  }

  function openSavedComparison(
    comparison,
  ) {
    const records =
      comparison.recordIds
        .map((id) =>
          history.find(
            (record) => record.id === id,
          ),
        )
        .filter(Boolean)

    if (records.length < 2) {
      window.alert(
        'This comparison no longer has at least two available source reports.',
      )

      return
    }

    setComparisonPreview({
      comparison,
      records,
    })
  }

  function removeComparison(
    comparisonId,
  ) {
    setComparisons(
      deleteComparisonReport(
        user?.id,
        comparisonId,
      ),
    )
  }

  return (
    <WorkspaceShell
      title="Reports / History"
      description="Review saved analyses, build comparisons, and generate PDF reports."
      headerActions={
        <Link
          className="reports-header-cta no-print"
          to="/satellite-analysis"
        >
          <Satellite size={16} />
          New analysis
        </Link>
      }
    >
      <section className="reports-summary-grid">
        <article>
          <span><FileText size={20} /></span>

          <div>
            <small>Saved analyses</small>
            <strong>{history.length}</strong>
          </div>
        </article>

        <article>
          <span><Leaf size={20} /></span>

          <div>
            <small>Crop regions</small>
            <strong>{totals.crop}</strong>
          </div>
        </article>

        <article>
          <span><Droplets size={20} /></span>

          <div>
            <small>Water regions</small>
            <strong>{totals.water}</strong>
          </div>
        </article>

        <article>
          <span><Home size={20} /></span>

          <div>
            <small>Building regions</small>
            <strong>{totals.building}</strong>
          </div>
        </article>
      </section>

      <section className="reports-toolbar no-print">
        <div className="reports-search">
          <Search size={17} />

          <input
            value={query}
            onChange={(event) =>
              setQuery(event.target.value)
            }
            placeholder="Filter by location..."
            aria-label="Filter reports by location"
          />
        </div>

        <label className="reports-date-filter">
          <Filter size={16} />

          <select
            value={dateRange}
            onChange={(event) =>
              setDateRange(event.target.value)
            }
          >
            <option value="all">
              All dates
            </option>

            <option value="7">
              Last 7 days
            </option>

            <option value="30">
              Last 30 days
            </option>
          </select>
        </label>

        <button
          className="reports-clear-button"
          type="button"
          onClick={clearAll}
          disabled={
            !history.length &&
            !comparisons.length
          }
        >
          <Trash2 size={16} />
          Clear history
        </button>
      </section>

      <section className="reports-local-note">
        <FileText size={18} />

        <p>
          <strong>
            Efficient browser storage
          </strong>

          <span>
            Report metadata and comparison links are stored locally.
            Larger saved detection images remain in IndexedDB.
          </span>
        </p>
      </section>

      <section className="reports-tabs no-print">
        <button
          className={
            activeTab === 'reports'
              ? 'active'
              : ''
          }
          type="button"
          onClick={() =>
            setActiveTab('reports')
          }
        >
          All Reports
          <span>{history.length}</span>
        </button>

        <button
          className={
            activeTab === 'comparisons'
              ? 'active'
              : ''
          }
          type="button"
          onClick={() => {
            setActiveTab('comparisons')
            cancelCompare()
          }}
        >
          Comparison Reports
          <span>{generalComparisons.length}</span>
        </button>

        <button
          className={
            activeTab === 'historical'
              ? 'active'
              : ''
          }
          type="button"
          onClick={() => {
            setActiveTab('historical')
            cancelCompare()
          }}
        >
          Historical Analysis Reports

          <span>
            {historicalComparisons.length}
          </span>
        </button>
      </section>

      {activeTab === 'reports' &&
        compareSelecting && (
          <section className="reports-selection-bar no-print">
            <div>
              <History size={18} />

              <p>
                <strong>
                  Select reports to compare
                </strong>

                <span>
                  {selectedCount} selected · choose at least 2.
                </span>
              </p>
            </div>

            <div>
              <button
                type="button"
                onClick={returnToCompareOptions}
              >
                <ArrowLeft size={15} />
                Return
              </button>

              <button
                className={
                  selectedCount >= 2
                    ? 'comparison-done ready'
                    : 'comparison-done'
                }
                type="button"
                disabled={selectedCount < 2}
                onClick={
                  finishGeneralComparison
                }
              >
                <Check size={15} />
                Done
              </button>
            </div>
          </section>
        )}

      {activeTab === 'reports' && (
        <>
          {filtered.length ? (
            <section className="reports-card-grid">
              {filtered.map((record) => {
                const selected =
                  selectedIds.includes(
                    record.id,
                  )

                return (
                  <article
                    className={
                      selected
                        ? 'report-card report-card-selected'
                        : 'report-card'
                    }
                    key={record.id}
                  >
                    <header>
                      <div className="report-location-icon">
                        <MapPin size={20} />
                      </div>

                      <div>
                        <span>
                          Satellite analysis
                        </span>

                        <h2>
                          {record.location}
                        </h2>

                        <p>
                          <CalendarDays size={14} />
                          {formatDate(
                            record.createdAt,
                          )}
                        </p>
                      </div>

                      <strong>
                        {number(
                          record.areaHectares,
                          2,
                        )} ha
                      </strong>

                      {compareSelecting && (
                        <button
                          className={
                            selected
                              ? 'report-select-toggle selected'
                              : 'report-select-toggle'
                          }
                          type="button"
                          onClick={() =>
                            toggleSelected(
                              record.id,
                            )
                          }
                        >
                          {selected && (
                            <Check size={14} />
                          )}

                          {selected
                            ? 'Selected'
                            : 'Select'}
                        </button>
                      )}
                    </header>

                    <div className="report-count-grid">
                      <div>
                        <small>Crop</small>

                        <strong>
                          {record.counts?.crop || 0}
                        </strong>

                        <span>
                          {number(
                            record.coverage?.crop,
                          )}%
                        </span>
                      </div>

                      <div>
                        <small>Water</small>

                        <strong>
                          {record.counts?.water || 0}
                        </strong>

                        <span>
                          {number(
                            record.coverage?.water,
                          )}%
                        </span>
                      </div>

                      <div>
                        <small>
                          Buildings
                        </small>

                        <strong>
                          {record.counts?.building || 0}
                        </strong>

                        <span>
                          {number(
                            record.coverage?.building,
                          )}%
                        </span>
                      </div>
                    </div>

                    <div className="report-evidence-line">
                      <BarChart3 size={15} />

                      <span>
                        {number(
                          record.meanModelCertainty,
                        )}%
                        {' '}mean model certainty
                      </span>
                    </div>

                    {!compareSelecting && (
                      <footer>
                        <button
                          className="report-view"
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
                          className="report-compare"
                          type="button"
                          onClick={() =>
                            setCompareChoiceRecord(
                              record,
                            )
                          }
                        >
                          Compare
                        </button>

                        <button
                          className="report-pdf"
                          type="button"
                          onClick={() =>
                            exportRecord(record)
                          }
                        >
                          <FileDown size={14} />
                          Generate PDF
                        </button>

                        <button
                          className="report-delete"
                          type="button"
                          onClick={() =>
                            removeRecord(
                              record.id,
                            )
                          }
                          aria-label="Delete report"
                        >
                          <Trash2 size={15} />
                        </button>
                      </footer>
                    )}
                  </article>
                )
              })}
            </section>
          ) : (
            <section className="reports-empty-state">
              <span>
                <FileText size={34} />
              </span>

              <h2>
                {history.length
                  ? 'No reports match these filters'
                  : 'No saved analyses yet'}
              </h2>

              <p>
                Complete a satellite analysis
                to create a report.
              </p>

              <Link to="/satellite-analysis">
                Open Satellite Analysis
                <ArrowRight size={16} />
              </Link>
            </section>
          )}
        </>
      )}

      {activeTab === 'comparisons' && (
        <>
          {generalComparisons.length ? (
            <section className="comparison-report-list">
              {generalComparisons.map(
                (comparison) => {
                  const availableRecords =
                    comparison.recordIds
                      .map((id) =>
                        history.find(
                          (record) =>
                            record.id === id,
                        ),
                      )
                      .filter(Boolean)

                  return (
                    <article
                      key={comparison.id}
                    >
                      <span className="comparison-report-icon">
                        <History size={20} />
                      </span>

                      <ComparisonArchiveIdentity
                        comparison={comparison}
                        records={availableRecords}
                      />

                      <div className="comparison-report-actions">
                        <button
                          type="button"
                          disabled={
                            availableRecords.length <
                            2
                          }
                          onClick={() =>
                            openSavedComparison(
                              comparison,
                            )
                          }
                        >
                          View
                        </button>

                        <button
                          type="button"
                          disabled={
                            availableRecords.length <
                            2
                          }
                          onClick={() =>
                            generateComparisonPdf(
                              availableRecords,
                              comparison,
                              user?.email || '',
                              user?.id || '',
                            )
                          }
                        >
                          <Download size={14} />
                          PDF
                        </button>

                        <button
                          className="comparison-delete"
                          type="button"
                          onClick={() =>
                            removeComparison(
                              comparison.id,
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  )
                },
              )}
            </section>
          ) : (
            <section className="reports-empty-state">
              <span>
                <History size={34} />
              </span>

              <h2>
                No comparison reports yet
              </h2>

              <p>
                Compare two or more reports to
                create a comparison report.
              </p>
            </section>
          )}
        </>
      )}

      {activeTab === 'historical' && (
        <>
          {historicalComparisons.length ? (
            <section className="comparison-report-list">
              {historicalComparisons.map(
                (comparison) => {
                  const availableRecords =
                    comparison.recordIds
                      .map((id) =>
                        history.find(
                          (record) =>
                            record.id === id,
                        ),
                      )
                      .filter(Boolean)

                  return (
                    <article key={comparison.id}>
                      <span className="comparison-report-icon">
                        <History size={20} />
                      </span>

                      <ComparisonArchiveIdentity
                        comparison={comparison}
                        records={availableRecords}
                        historical
                      />

                      <div className="comparison-report-actions">
                        <button
                          type="button"
                          disabled={
                            availableRecords.length < 2
                          }
                          onClick={() =>
                            openSavedComparison(
                              comparison,
                            )
                          }
                        >
                          View
                        </button>

                        <button
                          type="button"
                          disabled={
                            availableRecords.length < 2
                          }
                          onClick={() =>
                            generateComparisonPdf(
                              availableRecords,
                              comparison,
                              user?.email || '',
                              user?.id || '',
                            )
                          }
                        >
                          <Download size={14} />
                          PDF
                        </button>

                        <button
                          className="comparison-delete"
                          type="button"
                          onClick={() =>
                            removeComparison(
                              comparison.id,
                            )
                          }
                          aria-label="Delete historical analysis report"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  )
                },
              )}
            </section>
          ) : (
            <section className="reports-empty-state">
              <span>
                <History size={34} />
              </span>

              <h2>
                No Historical Analysis Reports yet
              </h2>

              <p>
                Open an individual report, choose Historical Analysis,
                analyze the exact same area again, then compare two or
                more historical runs. Saved historical comparisons will
                appear here.
              </p>
            </section>
          )}
        </>
      )}

      {compareChoiceRecord && (
        <div
          className="reports-choice-modal"
          role="dialog"
          aria-modal="true"
        >
          <button
            className="reports-choice-backdrop"
            type="button"
            aria-label="Close"
            onClick={() =>
              setCompareChoiceRecord(null)
            }
          />

          <section>
            <header>
              <div>
                <span>Compare</span>

                <h2>
                  {compareChoiceRecord.location}
                </h2>

                <p>
                  Choose how you want to use
                  this report.
                </p>
              </div>

              <button
                type="button"
                aria-label="Close"
                onClick={() =>
                  setCompareChoiceRecord(null)
                }
              >
                <X size={18} />
              </button>
            </header>

            <button
              className="comparison-choice"
              type="button"
              onClick={() =>
                beginCompare(
                  compareChoiceRecord,
                )
              }
            >
              <span>
                <FileText size={20} />
              </span>

              <div>
                <strong>
                  Compare Reports
                </strong>

                <small>
                  Select two or more saved
                  reports. Areas may be different.
                </small>
              </div>

              <ArrowRight size={17} />
            </button>

            <button
              className="comparison-choice"
              type="button"
              onClick={() => {
                const recordId =
                  compareChoiceRecord.id

                setCompareChoiceRecord(null)

                setCompareOriginRecordId(recordId)

                navigate(
                  `/reports/history/${encodeURIComponent(
                    recordId,
                  )}`,
                )
              }}
            >
              <span>
                <History size={20} />
              </span>

              <div>
                <strong>
                  Historical Analysis
                </strong>

                <small>
                  Open this exact saved land
                  boundary and its repeated
                  analyses.
                </small>
              </div>

              <ArrowRight size={17} />
            </button>
          </section>
        </div>
      )}

      {selectedRecord && (
        <ReportDetailsModal
          record={selectedRecord}
          userId={user?.id || ''}
          accountLabel={user?.email || ''}
          onClose={() =>
            setSelectedRecord(null)
          }
          onCompare={(record) => {
            setSelectedRecord(null)
            setCompareChoiceRecord(record)
          }}
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

export default Reports
