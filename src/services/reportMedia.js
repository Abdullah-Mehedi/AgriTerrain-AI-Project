const DB_NAME = 'agriterrain_report_media'
const DB_VERSION = 1
const STORE_NAME = 'media'

function normaliseUserId(userId) {
  return String(userId || 'anonymous')
}

function mediaKey(userId, recordId) {
  return `${normaliseUserId(userId)}:${recordId}`
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      resolve(null)
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'key',
        })

        store.createIndex('userId', 'userId', {
          unique: false,
        })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveReportMedia(
  userId,
  recordId,
  overlayImage,
) {
  if (!recordId || !overlayImage) return false

  const db = await openDatabase()
  if (!db) return false

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STORE_NAME,
      'readwrite',
    )

    transaction.objectStore(STORE_NAME).put({
      key: mediaKey(userId, recordId),
      userId: normaliseUserId(userId),
      recordId,
      overlayImage,
      savedAt: new Date().toISOString(),
    })

    transaction.oncomplete = () => {
      db.close()
      resolve(true)
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }

    transaction.onabort = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

export async function getReportMedia(userId, recordId) {
  if (!recordId) return null

  const db = await openDatabase()
  if (!db) return null

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STORE_NAME,
      'readonly',
    )

    const request = transaction
      .objectStore(STORE_NAME)
      .get(mediaKey(userId, recordId))

    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => db.close()
    transaction.onerror = () => db.close()
  })
}

export async function deleteReportMedia(userId, recordId) {
  if (!recordId) return false

  const db = await openDatabase()
  if (!db) return false

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STORE_NAME,
      'readwrite',
    )

    transaction
      .objectStore(STORE_NAME)
      .delete(mediaKey(userId, recordId))

    transaction.oncomplete = () => {
      db.close()
      resolve(true)
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

export async function clearReportMediaForUser(userId) {
  const db = await openDatabase()
  if (!db) return false

  const targetUserId = normaliseUserId(userId)

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      STORE_NAME,
      'readwrite',
    )

    const store = transaction.objectStore(STORE_NAME)
    const index = store.index('userId')

    const request = index.openCursor(
      IDBKeyRange.only(targetUserId),
    )

    request.onsuccess = () => {
      const cursor = request.result

      if (!cursor) return

      cursor.delete()
      cursor.continue()
    }

    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => {
      db.close()
      resolve(true)
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}
