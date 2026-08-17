import { buildRecommendations } from './history'
import { getReportMedia } from './reportMedia'

const ML_API_URL =
  import.meta.env.VITE_ML_API_URL ||
  'http://127.0.0.1:8000'

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
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—'
}

function sourceRows(record) {
  const modelSource =
    record?.model?.source ||
    'https://github.com/sebastianbahr/OpenEarthMap'

  return [
    ['OpenEarthMap model', modelSource],
    ['OpenStreetMap', 'https://www.openstreetmap.org/'],
    ['Copernicus Data Space', 'https://dataspace.copernicus.eu/'],
    ['USGS Landsat', 'https://www.usgs.gov/landsat-missions/landsat-data-access'],
    ['Open-Meteo', 'https://open-meteo.com/'],
  ]
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image()

    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(new Error('Unable to load report image.'))

    image.src = source
  })
}

function getBoundaryBox(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) {
    return null
  }

  const latitudes = boundary.map(
    (point) => Number(point?.[0]),
  )

  const longitudes = boundary.map(
    (point) => Number(point?.[1]),
  )

  if (
    latitudes.some((value) => !Number.isFinite(value)) ||
    longitudes.some((value) => !Number.isFinite(value))
  ) {
    return null
  }

  return {
    south: Math.min(...latitudes),
    west: Math.min(...longitudes),
    north: Math.max(...latitudes),
    east: Math.max(...longitudes),
  }
}

function drawBoundary(
  context,
  boundary,
  box,
  width,
  height,
) {
  if (!box || boundary.length < 3) return

  const longitudeSpan = box.east - box.west
  const latitudeSpan = box.north - box.south

  if (longitudeSpan <= 0 || latitudeSpan <= 0) return

  context.beginPath()

  boundary.forEach(([latitude, longitude], index) => {
    const x =
      ((Number(longitude) - box.west) / longitudeSpan) *
      (width - 1)

    const y =
      ((box.north - Number(latitude)) / latitudeSpan) *
      (height - 1)

    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })

  context.closePath()

  context.strokeStyle = '#11693c'
  context.lineWidth = 7
  context.lineJoin = 'round'
  context.stroke()

  context.strokeStyle = '#9aec6a'
  context.lineWidth = 4
  context.stroke()
}

async function fetchReportBackground(boundary) {
  const controller = new AbortController()

  const timeout = window.setTimeout(
    () => controller.abort(),
    15000,
  )

  try {
    const response = await fetch(
      `${ML_API_URL}/report-background`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ boundary }),
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      throw new Error(
        'Satellite background unavailable for report.',
      )
    }

    const result = await response.json()

    if (
      typeof result.image !== 'string' ||
      !result.image.startsWith('data:image/')
    ) {
      throw new Error(
        'Invalid satellite report image.',
      )
    }

    return result.image
  } finally {
    window.clearTimeout(timeout)
  }
}

async function createComparison(
  record,
  userId,
) {
  if (
    !record?.id ||
    !Array.isArray(record.boundary) ||
    record.boundary.length < 3
  ) {
    return null
  }

  const media = await getReportMedia(
    userId,
    record.id,
  )

  if (
    !media?.overlayImage ||
    !String(media.overlayImage).startsWith('data:image/')
  ) {
    return null
  }

  const backgroundSource =
    await fetchReportBackground(record.boundary)

  const [background, overlay] =
    await Promise.all([
      loadImage(backgroundSource),
      loadImage(media.overlayImage),
    ])

  const width =
    background.naturalWidth || 512

  const height =
    background.naturalHeight || 512

  const box = getBoundaryBox(record.boundary)

  if (!box) return null

  const canvas =
    document.createElement('canvas')

  canvas.width = width
  canvas.height = height

  const context =
    canvas.getContext('2d')

  if (!context) return null

  // BEFORE DETECTION
  context.clearRect(
    0,
    0,
    width,
    height,
  )

  context.drawImage(
    background,
    0,
    0,
    width,
    height,
  )

  drawBoundary(
    context,
    record.boundary,
    box,
    width,
    height,
  )

  const beforeImage =
    canvas.toDataURL(
      'image/jpeg',
      0.88,
    )

  // AFTER DETECTION
  context.clearRect(
    0,
    0,
    width,
    height,
  )

  context.drawImage(
    background,
    0,
    0,
    width,
    height,
  )

  context.drawImage(
    overlay,
    0,
    0,
    width,
    height,
  )

  drawBoundary(
    context,
    record.boundary,
    box,
    width,
    height,
  )

  const afterImage =
    canvas.toDataURL(
      'image/jpeg',
      0.88,
    )

  return {
    beforeImage,
    afterImage,
  }
}

function writeReport(
  reportWindow,
  record,
  accountLabel,
  comparison,
) {
  const recommendations =
    buildRecommendations(record)

  const sources =
    sourceRows(record)

  const created = record.createdAt
    ? new Date(record.createdAt).toLocaleString()
    : '—'

  const classThresholds =
    record.classThresholds || {}

  const hasComparison = Boolean(
    comparison?.beforeImage &&
    comparison?.afterImage,
  )

  reportWindow.document.open()

  reportWindow.document.write(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AgriTerrain AI Analysis Report</title>

<style>
  @page {
    size: A4;
    margin: 16mm;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    font-family: Arial, Helvetica, sans-serif;
    color: #17301f;
    background: #fff;
    font-size: 12px;
    line-height: 1.5;
  }

  header {
    border-bottom: 3px solid #16864f;
    padding-bottom: 14px;
    margin-bottom: 18px;
  }

  .brand {
    color: #16864f;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: .02em;
  }

  h1 {
    font-size: 26px;
    margin: 7px 0 3px;
  }

  h2 {
    color: #17663e;
    font-size: 15px;
    margin: 20px 0 8px;
  }

  p {
    margin: 4px 0;
  }

  .meta {
    color: #5e7164;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 9px;
  }

  .card {
    border: 1px solid #d8e6dc;
    border-radius: 9px;
    padding: 10px;
    background: #f8fbf8;
  }

  .card span {
    display: block;
    color: #6a796e;
    font-size: 10px;
    text-transform: uppercase;
  }

  .card strong {
    display: block;
    font-size: 18px;
    margin-top: 3px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    text-align: left;
    border: 1px solid #dbe6de;
    padding: 7px;
    vertical-align: top;
  }

  th {
    background: #eef7f0;
  }

  ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }

  li {
    margin: 5px 0;
  }

  .note {
    border-left: 4px solid #e09b36;
    background: #fff8eb;
    padding: 9px 11px;
    margin-top: 8px;
  }

  .science {
    border-left-color: #3b82a6;
    background: #f1f8fb;
  }

  a {
    color: #176d46;
    overflow-wrap: anywhere;
  }

  .selected-area-comparison {
    margin-top: 10px;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .selected-area-comparison h2 {
    margin: 0 0 5px;
  }

  .comparison-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .comparison-card {
    margin: 0;
    padding: 5px;
    border: 1px solid #dbe6de;
    border-radius: 7px;
    background: #f8fbf8;
    text-align: center;
  }

  .comparison-card img {
    display: block;
    width: 100%;
    height: 118px;
    object-fit: contain;
    border-radius: 4px;
    background: #edf2ee;
  }

  .comparison-card figcaption {
    margin-top: 3px;
    color: #17663e;
    font-size: 9px;
    font-weight: 800;
  }

  footer {
    margin-top: 12px;
    border-top: 1px solid #dbe6de;
    padding-top: 8px;
    color: #68786d;
    font-size: 10px;
  }

  .no-print {
    margin: 16px 0;
    padding: 10px;
    background: #eef7f0;
    border-radius: 8px;
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

  <h1>Satellite Analysis Report</h1>

  <p class="meta">
    ${escapeHtml(record.location)}
    · Generated from analysis saved
    ${escapeHtml(created)}
  </p>

  ${
    accountLabel
      ? `<p class="meta">Account: ${escapeHtml(accountLabel)}</p>`
      : ''
  }
</header>

<section class="grid">
  <div class="card">
    <span>Selected area</span>
    <strong>${number(record.areaHectares, 2)} ha</strong>
  </div>

  <div class="card">
    <span>Mean model certainty</span>
    <strong>${number(record.meanModelCertainty)}%</strong>
  </div>

  <div class="card">
    <span>User threshold</span>
    <strong>${number(record.confidenceThreshold, 0)}%</strong>
  </div>
</section>

<h2>Detection summary</h2>

<table>
  <thead>
    <tr>
      <th>Class</th>
      <th>Separated regions</th>
      <th>Selected-area coverage</th>
      <th>Effective class floor</th>
    </tr>
  </thead>

  <tbody>
    <tr>
      <td>Crop</td>
      <td>${number(record.counts?.crop, 0)}</td>
      <td>${number(record.coverage?.crop)}%</td>
      <td>${classThresholds.crop != null ? `${number(classThresholds.crop)}%` : '—'}</td>
    </tr>

    <tr>
      <td>Water</td>
      <td>${number(record.counts?.water, 0)}</td>
      <td>${number(record.coverage?.water)}%</td>
      <td>${classThresholds.water != null ? `${number(classThresholds.water)}%` : '—'}</td>
    </tr>

    <tr>
      <td>Building</td>
      <td>${number(record.counts?.building, 0)}</td>
      <td>${number(record.coverage?.building)}%</td>
      <td>${classThresholds.building != null ? `${number(classThresholds.building)}%` : '—'}</td>
    </tr>
  </tbody>
</table>

<p class="note">
  Region counts are separated semantic-mask components.
  They are not verified cadastral field counts, pond counts,
  or individual house totals.
</p>

<h2>Model and imagery evidence</h2>

<table>
  <tbody>
    <tr>
      <th>Model</th>
      <td>${escapeHtml(record.model?.name || 'OpenEarthMap land-cover model')}</td>
    </tr>

    <tr>
      <th>Input</th>
      <td>${escapeHtml(record.model?.input || 'RGB satellite imagery')}</td>
    </tr>

    <tr>
      <th>Imagery provider</th>
      <td>${escapeHtml(record.imagery?.provider || '—')}</td>
    </tr>

    <tr>
      <th>Estimated detail</th>
      <td>${number(record.imagery?.estimated_gsd_metres, 2)} m/pixel</td>
    </tr>

    <tr>
      <th>Imagery date note</th>
      <td>${escapeHtml(record.imagery?.date_note || 'Capture date was not provided by the current imagery endpoint.')}</td>
    </tr>
  </tbody>
</table>

<h2>Weather context</h2>

${
  record.weather
    ? `
<table>
<tbody>
<tr>
  <th>Temperature</th>
  <td>${number(record.weather.temperature)} °C</td>

  <th>Humidity</th>
  <td>${number(record.weather.humidity, 0)}%</td>
</tr>

<tr>
  <th>Precipitation</th>
  <td>${number(record.weather.precipitation)} mm</td>

  <th>Wind</th>
  <td>${number(record.weather.windSpeed)} km/h</td>
</tr>
</tbody>
</table>`
    : '<p>Weather was unavailable when this analysis was saved.</p>'
}

<h2>Crop health / vegetation indices</h2>

<p class="note science">
  <strong>
    NDVI and NDWI are not calculated by the current RGB workflow.
  </strong>

  A scientifically meaningful vegetation or water index requires
  suitable multispectral bands. This report leaves those values
  unavailable instead of inventing a crop-health score.
</p>

<h2>Recommendations</h2>

<ul>
  ${
    recommendations
      .map(
        (item) =>
          `<li>${escapeHtml(item)}</li>`,
      )
      .join('')
  }
</ul>

<h2>Limitations</h2>

<p>
  ${escapeHtml(
    record.warning ||
      'AI-assisted land-cover output should be verified with local observations and labelled reference data before important decisions.',
  )}
</p>

<h2>Sources and follow-up data</h2>

<table>
<tbody>
${
  sources
    .map(
      ([label, url]) =>
        `<tr><th>${escapeHtml(label)}</th><td><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></td></tr>`,
    )
    .join('')
}
</tbody>
</table>

${
  hasComparison
    ? `
<section class="selected-area-comparison">

  <h2>Selected area comparison</h2>

  <div class="comparison-grid">

    <figure class="comparison-card">
      <img
        src="${comparison.beforeImage}"
        alt="Selected area before detection"
      />

      <figcaption>
        Before detection
      </figcaption>
    </figure>

    <figure class="comparison-card">
      <img
        src="${comparison.afterImage}"
        alt="Selected area after detection"
      />

      <figcaption>
        After detection
      </figcaption>
    </figure>

  </div>

</section>
`
    : ''
}

<div class="no-print">
  <strong>PDF step:</strong>
  In the print dialog, choose
  <em>Save as PDF</em>.
</div>

<footer>
  AgriTerrain AI · Research-oriented satellite land-cover analysis.
  Generated values should not be treated as survey, cadastral,
  agronomic, or emergency-risk determinations.
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
}

export async function generateAnalysisPdf(
  record,
  accountLabel = '',
  userId = '',
) {
  if (!record) return false

  // Opens immediately so browser popup protection does not block it.
  const reportWindow = window.open(
    '',
    '_blank',
    'width=900,height=1100',
  )

  if (!reportWindow) return false

  reportWindow.opener = null

  reportWindow.document.write(`<!doctype html>
<html>
<head>
<title>Preparing AgriTerrain report...</title>
<style>
body {
  font-family: Arial, Helvetica, sans-serif;
  padding: 32px;
  color: #17301f;
}
</style>
</head>

<body>
<p>
  <strong>Preparing report...</strong>
</p>

<p>
  Loading optional before/after satellite comparison.
</p>
</body>
</html>`)

  reportWindow.document.close()

  let comparison = null

  try {
    comparison = await createComparison(
      record,
      userId,
    )
  } catch (error) {
    console.warn(
      'PDF comparison unavailable; generating standard report.',
      error,
    )
  }

  writeReport(
    reportWindow,
    record,
    accountLabel,
    comparison,
  )

  return true
}
