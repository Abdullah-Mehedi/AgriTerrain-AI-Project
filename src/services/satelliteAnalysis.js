const ML_API_URL =
  import.meta.env.VITE_ML_API_URL?.replace(/\/$/, '') ||
  'http://127.0.0.1:8000'

export const MAX_ANALYSIS_SIDE_METRES = 420
export const TARGET_IMAGE_PIXELS = 512

export function getBoundaryBox(boundary) {
  if (!boundary.length) return null
  const latitudes = boundary.map(([latitude]) => latitude)
  const longitudes = boundary.map(([, longitude]) => longitude)

  return {
    south: Math.min(...latitudes),
    west: Math.min(...longitudes),
    north: Math.max(...latitudes),
    east: Math.max(...longitudes),
  }
}

export function calculateAreaHectares(boundary) {
  if (boundary.length < 3) return 0

  const averageLatitude =
    boundary.reduce((total, point) => total + point[0], 0) / boundary.length
  const metresPerLongitude =
    111320 * Math.cos((averageLatitude * Math.PI) / 180)
  const metresPerLatitude = 110540
  const points = boundary.map(([latitude, longitude]) => [
    longitude * metresPerLongitude,
    latitude * metresPerLatitude,
  ])

  let twiceArea = 0
  points.forEach(([x1, y1], index) => {
    const [x2, y2] = points[(index + 1) % points.length]
    twiceArea += x1 * y2 - x2 * y1
  })

  return Math.abs(twiceArea) / 2 / 10000
}

export function calculateBoundaryMetrics(boundary) {
  const box = getBoundaryBox(boundary)
  if (!box) {
    return {
      areaHectares: 0,
      widthMetres: 0,
      heightMetres: 0,
      longestSideMetres: 0,
      estimatedGsdMetres: 0,
      quality: 'unknown',
      validForAnalysis: false,
    }
  }

  const centreLatitude = (box.north + box.south) / 2
  const widthMetres =
    Math.abs(box.east - box.west) *
    111320 *
    Math.cos((centreLatitude * Math.PI) / 180)
  const heightMetres = Math.abs(box.north - box.south) * 110540
  const longestSideMetres = Math.max(widthMetres, heightMetres)
  const shortestSideMetres = Math.min(widthMetres, heightMetres)
  const estimatedGsdMetres = longestSideMetres / TARGET_IMAGE_PIXELS

  let quality = 'fair'
  if (estimatedGsdMetres <= 0.65) quality = 'excellent'
  else if (estimatedGsdMetres <= 1) quality = 'good'

  return {
    areaHectares: calculateAreaHectares(boundary),
    widthMetres,
    heightMetres,
    longestSideMetres,
    estimatedGsdMetres,
    quality,
    validForAnalysis:
      boundary.length >= 3 &&
      longestSideMetres <= MAX_ANALYSIS_SIDE_METRES &&
      shortestSideMetres >= 20,
  }
}

async function readError(response, fallback) {
  const data = await response.json().catch(() => null)
  return data?.detail || data?.message || fallback
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

export async function checkMlService() {
  try {
    const response = await fetchWithTimeout(`${ML_API_URL}/health`, {}, 5000)
    if (!response.ok) throw new Error('The AI service returned an error.')
    const data = await response.json()
    return {
      online: true,
      modelReady: Boolean(data.model_ready),
      modelLoaded: Boolean(data.model_loaded),
      status: data.model_status || 'unknown',
      model: data.model || 'OpenEarthMap model',
      downloadMb: data.model_download_mb || 304,
      detail: data.last_error || '',
    }
  } catch (error) {
    return {
      online: false,
      modelReady: false,
      modelLoaded: false,
      status: 'offline',
      model: 'OpenEarthMap U-Net EfficientNet-B4',
      downloadMb: 304,
      detail:
        error.name === 'AbortError'
          ? 'The local AI service did not respond.'
          : error.message || 'The local AI service is offline.',
    }
  }
}

export async function prepareMlModel() {
  let response
  try {
    response = await fetchWithTimeout(
      `${ML_API_URL}/prepare`,
      { method: 'POST' },
      30 * 60 * 1000,
    )
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The model preparation timed out. Check the AI-service terminal.', {
        cause: error,
      })
    }
    throw new Error('The AI service disconnected while preparing the model.', {
      cause: error,
    })
  }

  if (!response.ok) {
    throw new Error(
      await readError(response, 'The OpenEarthMap model could not be prepared.'),
    )
  }
  return response.json()
}

function isCoordinatePair(value) {
  if (!Array.isArray(value) || value.length < 2) return false

  const latitude = Number(value[0])
  const longitude = Number(value[1])

  return Number.isFinite(latitude) && Number.isFinite(longitude)
}

function normaliseCoordinateStructure(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null

  // Normal polygon ring:
  // [[lat, lng], [lat, lng], ...]
  if (isCoordinatePair(coordinates[0])) {
    const ring = coordinates
      .filter(isCoordinatePair)
      .map(([latitude, longitude]) => [
        Number(latitude),
        Number(longitude),
      ])

    return ring.length >= 3 ? ring : null
  }

  // Polygon with holes:
  // [
  //   [[lat, lng], ...],  // outer ring
  //   [[lat, lng], ...],  // pond/building hole
  // ]
  const rings = coordinates
    .map((ring) => normaliseCoordinateStructure(ring))
    .filter(Boolean)

  return rings.length > 0 ? rings : null
}

function normaliseRegions(regions) {
  if (!Array.isArray(regions)) return []

  return regions
    .map((region, index) => {
      const coordinates = normaliseCoordinateStructure(region.coordinates)

      if (!coordinates) return null

      return {
        id: region.id || `region-${index + 1}`,
        coordinates,
        areaM2: Number(region.area_m2 || 0),
        confidence: Number(region.confidence || 0),
      }
    })
    .filter(Boolean)
}

function normaliseAnalysis(result, boundary, location) {
  const detections = result.detections || {}
  const coverage = result.coverage || {}
  const counts = result.counts || {}

  return {
    mode: 'ml',
    location,
    areaHectares: Number(
      result.area_hectares ?? calculateAreaHectares(boundary),
    ),
    bbox: result.bbox || getBoundaryBox(boundary),
    confidenceThreshold: Number(result.confidence_threshold || 0),
    classThresholds: result.class_thresholds
      ? {
          crop: Number(result.class_thresholds.crop || 0),
          water: Number(result.class_thresholds.water || 0),
          building: Number(result.class_thresholds.building || 0),
        }
      : null,
    meanModelCertainty: Number(result.mean_model_certainty || 0),
    counts: {
      crop: Number(counts.crop || 0),
      water: Number(counts.water || 0),
      building: Number(counts.building || 0),
    },
    coverage: {
      crop: Number(coverage.crop || 0),
      water: Number(coverage.water || 0),
      building: Number(coverage.building || 0),
    },
    detections: {
      crop: normaliseRegions(detections.crop),
      water: normaliseRegions(detections.water),
      building: normaliseRegions(detections.building),
    },
    overlayImage: result.overlay_image || '',
    imagery: result.imagery || {},
    model: result.model || {},
    warning: result.warning || '',
    attribution: result.attribution || '',
    createdAt: new Date().toISOString(),
  }
}

export async function analyzeSatelliteBoundary(
  boundary,
  location,
  {
    confidenceThreshold = 0.55,
    quality = 'accurate',
    analysisMode = 'standard',
  } = {},
) {
  const metrics = calculateBoundaryMetrics(boundary)
  if (!metrics.validForAnalysis) {
    throw new Error(
      `Zoom in and draw a smaller area. Each side must be between 20 m and ${MAX_ANALYSIS_SIDE_METRES} m.`,
    )
  }

  let response
  try {
    response = await fetchWithTimeout(
      `${ML_API_URL}/analyze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boundary,
          location,
          confidence_threshold: confidenceThreshold,
          quality,
          analysis_mode: analysisMode,
        }),
      },
      15 * 60 * 1000,
    )
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('AI analysis timed out. Select a smaller area and try again.', {
        cause: error,
      })
    }
    throw new Error('The AI service disconnected during analysis.', { cause: error })
  }

  if (!response.ok) {
    throw new Error(await readError(response, 'Satellite analysis failed.'))
  }
  return normaliseAnalysis(await response.json(), boundary, location)
}

export async function fetchCurrentWeather([latitude, longitude], location) {
  const parameters = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current:
      'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code',
    timezone: 'auto',
  })
  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?${parameters}`,
  )

  if (!response.ok) {
    throw new Error('Weather information is temporarily unavailable.')
  }

  const data = await response.json()
  const current = data.current || {}
  return {
    location,
    temperature: current.temperature_2m,
    humidity: current.relative_humidity_2m,
    precipitation: current.precipitation,
    windSpeed: current.wind_speed_10m,
    weatherCode: current.weather_code,
    observedAt: current.time,
  }
}

export function getMlApiUrl() {
  return ML_API_URL
}
