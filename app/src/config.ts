// Адрес relay и база гостевых ссылок конфигурируются, чтобы Franke работал с
// self-host relay, а не только с localhost.
//
// Relay «слепой», его адрес не секретен (секретны только ключи во фрагменте #),
// поэтому его можно нести в query-параметре ссылки-приглашения — так гость
// подключается к тому же relay, что и владелец.
function env(key: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[key]
}

const DEFAULT_RELAY = 'ws://localhost:1234'
const DEFAULT_GUEST_BASE = 'http://localhost:5173'
const RELAY_STORAGE_KEY = 'franke-relay-url'

/**
 * Адрес relay. Приоритет: ?relay= (из ссылки, запоминается в localStorage) >
 * ранее сохранённый > build-env VITE_RELAY_URL > дефолт localhost.
 */
export function relayUrl(): string {
  try {
    const fromQuery = new URLSearchParams(location.search).get('relay')
    if (fromQuery) {
      localStorage.setItem(RELAY_STORAGE_KEY, fromQuery)
      return fromQuery
    }
    const saved = localStorage.getItem(RELAY_STORAGE_KEY)
    if (saved) return saved
  } catch {
    // location/localStorage недоступны (напр. SSR) — падаем на дефолты ниже.
  }
  return env('VITE_RELAY_URL') ?? DEFAULT_RELAY
}

/** База для генерации гостевых ссылок у владельца (публичный URL веб-клиента). */
export function guestUrlBase(): string {
  return env('VITE_GUEST_URL_BASE') ?? DEFAULT_GUEST_BASE
}
