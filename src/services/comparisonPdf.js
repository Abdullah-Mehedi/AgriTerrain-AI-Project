import { getReportVisuals } from './reportVisuals'

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function number(value, digits = 1) {
  const parsed = Number(value)

  return Number.isFinite(parsed)
    ? parsed.toFixed(digits)
    : '—'
}

function formatDate(value) {
  if (!value) return 'Unknown date'
  return new Date(value).toLocaleString()
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

async function loadDetectedImages(
  records,
  userId,
) {
  const entries =
    await Promise.all(
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
    )

  return Object.fromEntries(entries)
}

export async function generateComparisonPdf(
  records,
  comparison = {},
  accountLabel = '',
  userId = '',
) {
  if (
    !Array.isArray(records) ||
    records.length < 2
  ) {
    return false
  }

  const reportWindow = window.open(
    '',
    '_blank',
    'width=1050,height=1100',
  )

  if (!reportWindow) return false

  reportWindow.opener = null

  reportWindow.document.write(`<!doctype html>
<html>
<head>
<title>Preparing comparison...</title>
<style>
body {
  font-family: Arial, Helvetica, sans-serif;
  padding: 32px;
  color: #17301f;
}
</style>
</head>
<body>
<p><strong>Preparing comparison report...</strong></p>
<p>Composing actual detected satellite images.</p>
</body>
</html>`)

  reportWindow.document.close()

  const imageById =
    await loadDetectedImages(
      records,
      userId,
    )

  const historical =
    comparison.type === 'historical'

  reportWindow.document.open()

  reportWindow.document.write(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AgriTerrain AI Comparison Report</title>

<style>
@page {
  size: A4 landscape;
  margin: 13mm;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  color: #183024;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 11px;
  line-height: 1.45;
}

header {
  padding-bottom: 12px;
  border-bottom: 3px solid #16864f;
}

.brand {
  color: #16864f;
  font-size: 14px;
  font-weight: 900;
}

h1 {
  margin: 5px 0 3px;
  font-size: 24px;
}

h2 {
  margin: 17px 0 7px;
  color: #17663e;
  font-size: 14px;
}

.meta {
  margin: 2px 0;
  color: #67776c;
}

.note {
  margin-top: 12px;
  padding: 9px 11px;
  color: #6f5725;
  background: #fff8e9;
  border: 1px solid #f0dfb6;
  border-radius: 7px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 6px;
  border: 1px solid #dbe6de;
  vertical-align: top;
}

th {
  background: #eef7f0;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(${Math.min(records.length, 3)}, 1fr);
  gap: 9px;
}

.image-card {
  break-inside: avoid;
  padding: 9px;
  border: 1px solid #dbe6de;
  border-radius: 8px;
  background: #fafcfb;
}

.image-card h3 {
  margin: 0 0 2px;
  color: #183b26;
  font-size: 13px;
}

.image-card p {
  margin: 2px 0;
}

.image-card img {
  display: block;
  width: 100%;
  height: 180px;
  margin-top: 8px;
  object-fit: contain;
  background: #edf2ee;
  border-radius: 6px;
}

.no-image {
  min-height: 100px;
  display: grid;
  place-items: center;
  margin-top: 8px;
  color: #78867d;
  background: #f0f4f1;
  border-radius: 6px;
}

.no-print {
  margin-top: 15px;
  padding: 9px;
  background: #eef7f0;
  border-radius: 7px;
}

footer {
  margin-top: 14px;
  padding-top: 8px;
  color: #697a6f;
  border-top: 1px solid #dbe6de;
  font-size: 9px;
}

@media print {
  .no-print {
    display: none;
  }
}
</style>
</head>

<body>

<header>
  <div class="brand">AgriTerrain AI</div>

  <h1>
    ${historical
      ? 'Historical Analysis Comparison'
      : 'Report Comparison'}
  </h1>

  <p class="meta">
    ${escapeHtml(
      buildComparisonTitle(records),
    )}
  </p>

  ${
    accountLabel
      ? `<p class="meta">Account: ${escapeHtml(accountLabel)}</p>`
      : ''
  }

  <p class="meta">
    Created:
    ${escapeHtml(
      formatDate(
        comparison.createdAt ||
        new Date().toISOString(),
      ),
    )}
  </p>
</header>

<p class="note">
  ${
    historical
      ? 'All selected reports use the same exact saved polygon. The images below show the actual detected satellite result for each run.'
      : 'Selected reports may use different locations, areas, boundaries or dates. The images below show the actual detected satellite result for each report.'
  }
</p>

<h2>Report identity</h2>

<table>
<thead>
<tr>
  <th>Field</th>

  ${records.map(
    (record) =>
      `<th>${escapeHtml(record.location)}<br><small>${escapeHtml(formatDate(record.createdAt))}</small></th>`,
  ).join('')}
</tr>
</thead>

<tbody>
<tr>
  <th>Analysis date</th>

  ${records.map(
    (record) =>
      `<td>${escapeHtml(formatDate(record.createdAt))}</td>`,
  ).join('')}
</tr>

<tr>
  <th>Coordinates</th>

  ${records.map(
    (record) =>
      `<td>${escapeHtml(coordinateLabel(record))}</td>`,
  ).join('')}
</tr>

<tr>
  <th>Area</th>

  ${records.map(
    (record) =>
      `<td>${number(record.areaHectares, 2)} ha</td>`,
  ).join('')}
</tr>

<tr>
  <th>Crop</th>

  ${records.map(
    (record) =>
      `<td>${number(record.counts?.crop, 0)} · ${number(record.coverage?.crop)}%</td>`,
  ).join('')}
</tr>

<tr>
  <th>Water</th>

  ${records.map(
    (record) =>
      `<td>${number(record.counts?.water, 0)} · ${number(record.coverage?.water)}%</td>`,
  ).join('')}
</tr>

<tr>
  <th>Buildings</th>

  ${records.map(
    (record) =>
      `<td>${number(record.counts?.building, 0)} · ${number(record.coverage?.building)}%</td>`,
  ).join('')}
</tr>

<tr>
  <th>Model certainty</th>

  ${records.map(
    (record) =>
      `<td>${number(record.meanModelCertainty)}%</td>`,
  ).join('')}
</tr>
</tbody>
</table>

<h2>Actual detected satellite images</h2>

<div class="image-grid">

${records.map((record, index) => `
  <section class="image-card">

    <h3>
      ${escapeHtml(record.location)}
    </h3>

    <p>
      ${escapeHtml(formatDate(record.createdAt))}
      · ${number(record.areaHectares, 2)} ha
    </p>

    ${
      imageById[record.id]
        ? `<img src="${imageById[record.id]}" alt="Actual detected satellite result" />`
        : '<div class="no-image">Actual detected satellite image unavailable.</div>'
    }

  </section>
`).join('')}

</div>

<div class="no-print">
  <strong>PDF step:</strong>
  choose <em>Save as PDF</em> in the print dialog.
</div>

<footer>
  AgriTerrain AI comparison report.
  Analysis timestamps are not automatically satellite imagery capture dates.
</footer>

<script>
window.addEventListener('load', () => {
  const images = Array.from(document.images)

  Promise.all(
    images.map((image) => {
      if (image.complete) {
        return Promise.resolve()
      }

      return new Promise((resolve) => {
        image.addEventListener(
          'load',
          resolve,
          { once: true },
        )

        image.addEventListener(
          'error',
          resolve,
          { once: true },
        )
      })
    }),
  ).then(() => {
    setTimeout(
      () => window.print(),
      250,
    )
  })
})
</script>

</body>
</html>`)

  reportWindow.document.close()

  return true
}
