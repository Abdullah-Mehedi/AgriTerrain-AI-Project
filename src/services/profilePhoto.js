const DB_NAME = 'agriterrain_profile_media'
const DB_VERSION = 1
const STORE_NAME = 'profiles'

export const PROFILE_PHOTO_EVENT = 'agriterrain-profile-photo-changed'

function profileKey(userId) {
  return String(userId || 'anonymous')
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser.'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'userId' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function runTransaction(mode, action) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode)
        const store = transaction.objectStore(STORE_NAME)

        let request

        try {
          request = action(store)
        } catch (error) {
          database.close()
          reject(error)
          return
        }

        if (request) {
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        } else {
          transaction.oncomplete = () => resolve()
        }

        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)

        transaction.oncomplete = () => {
          database.close()
        }
      }),
  )
}

export async function getProfilePhoto(userId) {
  try {
    const record = await runTransaction(
      'readonly',
      (store) => store.get(profileKey(userId)),
    )

    return record?.dataUrl || ''
  } catch {
    return ''
  }
}

export async function saveProfilePhoto(userId, dataUrl) {
  const key = profileKey(userId)

  await runTransaction(
    'readwrite',
    (store) =>
      store.put({
        userId: key,
        dataUrl,
        updatedAt: new Date().toISOString(),
      }),
  )

  window.dispatchEvent(
    new CustomEvent(PROFILE_PHOTO_EVENT, {
      detail: {
        userId: key,
        dataUrl,
      },
    }),
  )
}

export async function deleteProfilePhoto(userId) {
  const key = profileKey(userId)

  await runTransaction(
    'readwrite',
    (store) => store.delete(key),
  )

  window.dispatchEvent(
    new CustomEvent(PROFILE_PHOTO_EVENT, {
      detail: {
        userId: key,
        dataUrl: '',
      },
    }),
  )
}
