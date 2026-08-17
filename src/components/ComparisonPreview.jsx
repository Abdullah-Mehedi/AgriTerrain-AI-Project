import { useEffect, useState } from 'react'
import {
  Download,
  FileText,
  X,
} from 'lucide-react'
import { getReportVisuals } from '../services/reportVisuals'
import { generateComparisonPdf } from '../services/comparisonPdf'
import './ComparisonPreview.css'

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

function ComparisonPreview({
  comparison,
  records,
  userId,
  accountLabel,
  onClose,
}) {
  const [imagesById, setImagesById] =
    useState({})

  useEffect(() => {
    let active = true

    Promise.all(
      records.map(async (record) => {
        try {
          const visuals =
            await getReportVisuals(
              userId,
              record,
            )

          return [
            record.id,
            visuals?.afterImage || '',
          ]
        } catch {
          return [record.id, '']
        }
      }),
    ).then((entries) => {
      if (active) {
        setImagesById(
          Object.fromEntries(entries),
        )
      }
    })

    return () => {
      active = false
    }
  }, [records, userId])

  if (
    !comparison ||
    records.length < 2
  ) {
    return null
  }

  const historical =
    comparison.type === 'historical'

  return (
    <div
      className="comparison-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Comparison report preview"
    >
      <button
        className="comparison-preview-backdrop"
        type="button"
        aria-label="Close comparison"
        onClick={onClose}
      />

      <section>
        <header className="comparison-preview-header">
          <div>
            <span>
              {historical
                ? 'Historical comparison'
                : 'Report comparison'}
            </span>

            <h2>
              {buildComparisonTitle(records)}
            </h2>

            <p>
              {records.length} saved analyses ·{' '}
              {formatDate(comparison.createdAt)}
            </p>
          </div>

          <button
            type="button"
            aria-label="Close comparison"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="comparison-preview-body">
          <div className="comparison-preview-note">
            <FileText size={17} />

            <p>
              {historical
                ? 'These analyses use the same exact saved polygon. The images below show the actual satellite scene with the saved detection overlay.'
                : 'Reports may use different locations, areas, boundaries or dates. Each image below is the actual detected satellite result for that saved report.'}
            </p>
          </div>

          <section className="comparison-preview-grid">
            {records.map((record, index) => (
              <article key={record.id}>
                <header>
                  <div>
                    <strong>{record.location}</strong>

                    <small>
                      {formatDate(record.createdAt)}
                    </small>
                  </div>
                </header>

                <dl>
                  <div>
                    <dt>Coordinates</dt>
                    <dd>{coordinateLabel(record)}</dd>
                  </div>

                  <div>
                    <dt>Area</dt>
                    <dd>
                      {number(record.areaHectares, 2)} ha
                    </dd>
                  </div>

                  <div>
                    <dt>Crop</dt>
                    <dd>
                      {record.counts?.crop || 0} ·{' '}
                      {number(record.coverage?.crop)}%
                    </dd>
                  </div>

                  <div>
                    <dt>Water</dt>
                    <dd>
                      {record.counts?.water || 0} ·{' '}
                      {number(record.coverage?.water)}%
                    </dd>
                  </div>

                  <div>
                    <dt>Buildings</dt>
                    <dd>
                      {record.counts?.building || 0} ·{' '}
                      {number(record.coverage?.building)}%
                    </dd>
                  </div>

                  <div>
                    <dt>Model certainty</dt>
                    <dd>
                      {number(
                        record.meanModelCertainty,
                      )}%
                    </dd>
                  </div>
                </dl>

                <div className="comparison-preview-image">
                  {imagesById[record.id] ? (
                    <img
                      src={imagesById[record.id]}
                      alt={`Actual detected satellite result for ${record.location}`}
                    />
                  ) : (
                    <span>
                      Actual detected satellite image unavailable.
                    </span>
                  )}
                </div>
              </article>
            ))}
          </section>
        </div>

        <footer className="comparison-preview-actions">
          <button
            type="button"
            onClick={() =>
              generateComparisonPdf(
                records,
                comparison,
                accountLabel,
                userId,
              )
            }
          >
            <Download size={16} />
            Generate comparison PDF
          </button>
        </footer>
      </section>
    </div>
  )
}

export default ComparisonPreview
