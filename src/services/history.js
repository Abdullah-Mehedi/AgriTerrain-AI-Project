const HISTORY_PREFIX = 'agriterrain_analysis_history'
const MAX_HISTORY_RECORDS = 30

function storageKey(userId) {
  return `${HISTORY_PREFIX}:${userId || 'anonymous'}`
}

function safeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function getAnalysisHistory(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveAnalysisHistoryRecord(userId, record) {
  const history = getAnalysisHistory(userId)
  const next = [record, ...history.filter((item) => item.id !== record.id)].slice(
    0,
    MAX_HISTORY_RECORDS,
  )
  localStorage.setItem(storageKey(userId), JSON.stringify(next))
  return next
}

export function deleteAnalysisHistoryRecord(userId, recordId) {
  const next = getAnalysisHistory(userId).filter((record) => record.id !== recordId)
  localStorage.setItem(storageKey(userId), JSON.stringify(next))
  return next
}

export function clearAnalysisHistory(userId) {
  localStorage.removeItem(storageKey(userId))
  return []
}

export function compactAnalysisForHistory({
  analysis,
  weather,
  boundary,
  coordinates,
}) {
  if (!analysis) return null

  const createdAt = analysis.createdAt || new Date().toISOString()
  const id = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`

  return {
    id,
    createdAt,
    location: analysis.location || 'Selected location',
    coordinates: Array.isArray(coordinates) ? coordinates : null,
    boundary: Array.isArray(boundary) ? boundary : [],
    areaHectares: safeNumber(analysis.areaHectares),
    confidenceThreshold: safeNumber(analysis.confidenceThreshold),
    meanModelCertainty: safeNumber(analysis.meanModelCertainty),
    counts: {
      crop: safeNumber(analysis.counts?.crop),
      water: safeNumber(analysis.counts?.water),
      building: safeNumber(analysis.counts?.building),
    },
    coverage: {
      crop: safeNumber(analysis.coverage?.crop),
      water: safeNumber(analysis.coverage?.water),
      building: safeNumber(analysis.coverage?.building),
    },
    imagery: analysis.imagery || {},
    model: analysis.model || {},
    classThresholds: analysis.classThresholds || null,
    weather: weather
      ? {
          temperature: weather.temperature,
          humidity: weather.humidity,
          precipitation: weather.precipitation,
          windSpeed: weather.windSpeed,
          observedAt: weather.observedAt,
        }
      : null,
    warning: analysis.warning || '',
  }
}

export function findPreviousComparableRecord(history, currentRecord) {
  if (!currentRecord || !Array.isArray(history)) return null
  const currentName = String(currentRecord.location || '').trim().toLowerCase()
  if (!currentName) return null

  const currentTime = new Date(currentRecord.createdAt || 0).getTime()
  return (
    history.find((record) => {
      if (record.id === currentRecord.id) return false
      if (String(record.location || '').trim().toLowerCase() !== currentName) return false
      const recordTime = new Date(record.createdAt || 0).getTime()
      if (!Number.isFinite(currentTime) || !Number.isFinite(recordTime)) return true
      return recordTime < currentTime
    }) || null
  )
}

export function buildRecommendations(record) {
  if (!record) return []

  const crop = safeNumber(record.coverage?.crop)
  const water = safeNumber(record.coverage?.water)
  const building = safeNumber(record.coverage?.building)
  const rainfall = safeNumber(record.weather?.precipitation, NaN)
  const recommendations = []

  if (crop >= 35) {
    recommendations.push(
      'Crop cover is prominent in the selected RGB image. Inspect field condition on-site before making irrigation or fertilizer decisions.',
    )
  } else if (crop > 0) {
    recommendations.push(
      'Crop-labelled cover is limited in this selection. Try a tighter agricultural boundary if fields are the main target.',
    )
  } else {
    recommendations.push(
      'No crop regions passed the current model filters. Review the imagery and try a smaller boundary before concluding that crops are absent.',
    )
  }

  if (water >= 12) {
    recommendations.push(
      'Water-labelled cover is substantial. Verify pond and drainage edges visually because RGB land-cover models can confuse dark surfaces and shadows.',
    )
  }

  if (building >= 20) {
    recommendations.push(
      'The selected area contains notable building-labelled cover. Consider separating dense settlement from nearby fields when drawing the next boundary.',
    )
  }

  if (Number.isFinite(rainfall) && rainfall > 5) {
    recommendations.push(
      'Recent precipitation is elevated. Check low-lying fields and pond margins locally; this weather value alone is not a flood-risk model.',
    )
  }

  recommendations.push(
    'For crop-health scoring, connect multispectral Sentinel-2 bands and calculate vegetation indices; the current RGB workflow does not invent NDVI or NDWI.',
  )
  recommendations.push(
    'Treat every detection as AI-assisted evidence and verify important planning decisions with local observations or labelled reference data.',
  )

  return recommendations
}
