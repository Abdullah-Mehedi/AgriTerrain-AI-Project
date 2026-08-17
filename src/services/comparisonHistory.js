const COMPARISON_PREFIX = 'agriterrain_comparison_reports'
const MAX_COMPARISON_REPORTS = 40

function storageKey(userId) {
  return `${COMPARISON_PREFIX}:${userId || 'anonymous'}`
}

export function getComparisonHistory(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveComparisonReport(userId, comparison) {
  const history = getComparisonHistory(userId)

  const record = {
    ...comparison,
    id:
      comparison?.id ||
      `comparison-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt:
      comparison?.createdAt ||
      new Date().toISOString(),
    recordIds: Array.isArray(comparison?.recordIds)
      ? [...new Set(comparison.recordIds.filter(Boolean))]
      : [],
  }

  const next = [
    record,
    ...history.filter((item) => item.id !== record.id),
  ].slice(0, MAX_COMPARISON_REPORTS)

  localStorage.setItem(
    storageKey(userId),
    JSON.stringify(next),
  )

  return {
    record,
    history: next,
  }
}

export function deleteComparisonReport(userId, comparisonId) {
  const next = getComparisonHistory(userId).filter(
    (item) => item.id !== comparisonId,
  )

  localStorage.setItem(
    storageKey(userId),
    JSON.stringify(next),
  )

  return next
}

export function clearComparisonHistory(userId) {
  localStorage.removeItem(storageKey(userId))
  return []
}

export function removeComparisonsForRecord(userId, recordId) {
  const next = getComparisonHistory(userId).filter(
    (comparison) =>
      !comparison.recordIds?.includes(recordId),
  )

  localStorage.setItem(
    storageKey(userId),
    JSON.stringify(next),
  )

  return next
}
