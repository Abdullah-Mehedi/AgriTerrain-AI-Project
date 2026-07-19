import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    'Supabase environment variables are missing. Check the .env.local file.',
  )
}

const authStorage = {
  getItem(key) {
    const rememberSession =
      localStorage.getItem('agriterrain_remember_session') === 'true'

    const selectedStorage = rememberSession
      ? localStorage
      : sessionStorage

    return selectedStorage.getItem(key)
  },

  setItem(key, value) {
    const rememberSession =
      localStorage.getItem('agriterrain_remember_session') === 'true'

    const selectedStorage = rememberSession
      ? localStorage
      : sessionStorage

    const unusedStorage = rememberSession
      ? sessionStorage
      : localStorage

    unusedStorage.removeItem(key)
    selectedStorage.setItem(key, value)
  },

  removeItem(key) {
    localStorage.removeItem(key)
    sessionStorage.removeItem(key)
  },
}

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
      storage: authStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
)