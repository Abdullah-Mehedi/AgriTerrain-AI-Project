import { getReportMedia } from './reportMedia'

const ML_API_URL =
  import.meta.env.VITE_ML_API_URL ||
  'http://127.0.0.1:8000'

const visualCache = new Map()

function cacheKey(userId, recordId) {
  return `${userId || 'anonymous'}:${recordId}`
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

async function fetchBackground(boundary) {
  if (!Array.isArray(boundary) || boundary.length < 3) {
    throw new Error('A valid saved boundary is required.')
  }

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
        'Satellite background is unavailable.',
      )
    }

    const result = await response.json()

    if (
      typeof result.image !== 'string' ||
      !result.image.startsWith('data:image/')
    ) {
      throw new Error('Invalid satellite background.')
    }

    return result.image
  } finally {
    window.clearTimeout(timeout)
  }
}

async function buildVisuals(userId, record) {
  if (!record?.id) {
    throw new Error('Saved report is unavailable.')
  }

  const media = await getReportMedia(
    userId,
    record.id,
  )

  if (
    !media?.overlayImage ||
    !String(media.overlayImage).startsWith('data:image/')
  ) {
    throw new Error(
      'This report does not have a saved detection overlay.',
    )
  }

  const backgroundSource =
    await fetchBackground(record.boundary)

  const [background, overlay] =
    await Promise.all([
      loadImage(backgroundSource),
      loadImage(media.overlayImage),
    ])

  const width =
    background.naturalWidth || 512

  const height =
    background.naturalHeight || 512

  const canvas =
    document.createElement('canvas')

  canvas.width = width
  canvas.height = height

  const context =
    canvas.getContext('2d')

  if (!context) {
    throw new Error(
      'Browser image composition is unavailable.',
    )
  }

  // BEFORE: actual satellite image only.
  context.clearRect(0, 0, width, height)

  context.drawImage(
    background,
    0,
    0,
    width,
    height,
  )

  const beforeImage =
    canvas.toDataURL('image/jpeg', 0.9)

  // AFTER: actual satellite image + saved detection overlay.
  // No boundary outline is drawn here.
  context.clearRect(0, 0, width, height)

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

  const afterImage =
    canvas.toDataURL('image/jpeg', 0.9)

  return {
    beforeImage,
    afterImage,
  }
}

export async function getReportVisuals(
  userId,
  record,
) {
  if (!record?.id) return null

  const key =
    cacheKey(userId, record.id)

  if (visualCache.has(key)) {
    return visualCache.get(key)
  }

  const promise =
    buildVisuals(userId, record)
      .catch((error) => {
        visualCache.delete(key)
        throw error
      })

  visualCache.set(key, promise)

  return promise
}

export function clearReportVisualCache(
  userId,
  recordId,
) {
  visualCache.delete(
    cacheKey(userId, recordId),
  )
}
