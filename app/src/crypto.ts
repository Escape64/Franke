// E2E-шифрование документа: один симметричный ключ AES-GCM на документ.
// Ключ живёт в #-фрагменте ссылки-приглашения и никогда не уходит на сервер
// (фрагмент не передаётся по сети — стандартное поведение URL).
const ALGO = 'AES-GCM'
const IV_BYTES = 12

function toBase64Url(data: Uint8Array): string {
  let bin = ''
  for (const b of data) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export { toBase64Url, fromBase64Url }

/** Случайный идентификатор документа (не содержит ничего про заметку). */
export function randomDocId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

export async function generateKeyB64(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: ALGO, length: 256 }, true, [
    'encrypt',
    'decrypt'
  ])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  return toBase64Url(raw)
}

export async function importKeyB64(b64: string): Promise<CryptoKey> {
  const raw = fromBase64Url(b64)
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: ALGO }, false, [
    'encrypt',
    'decrypt'
  ])
}

/** iv (12 байт) + шифротекст одним буфером. */
export async function encryptBlob(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv }, key, data as BufferSource)
  )
  const out = new Uint8Array(IV_BYTES + ct.length)
  out.set(iv, 0)
  out.set(ct, IV_BYTES)
  return out
}

export async function decryptBlob(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, IV_BYTES)
  const ct = data.slice(IV_BYTES)
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct as BufferSource)
  )
}

// --- Подписи правок (права записи ≠ права чтения) ---
// Запись подтверждается подписью ECDSA P-256: приватный ключ есть только у
// писателей, публичный (проверочный) — у всех читателей. Подпись WebCrypto
// для P-256 — ровно 64 байта (r||s), что позволяет класть её префиксом
// внутрь шифрованного конверта.
const SIGN_ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const

export const SIGNATURE_BYTES = 64

export interface SignPairB64 {
  pub: string
  priv: string
}

export async function generateSignPair(): Promise<SignPairB64> {
  const pair = await crypto.subtle.generateKey(SIGN_ALGO, true, ['sign', 'verify'])
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return { pub: toBase64Url(pub), priv: toBase64Url(priv) }
}

export async function importVerifyKey(pubB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromBase64Url(pubB64) as BufferSource,
    SIGN_ALGO,
    false,
    ['verify']
  )
}

export async function importSignKey(privB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(privB64) as BufferSource,
    SIGN_ALGO,
    false,
    ['sign']
  )
}

export async function signData(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(SIGN_PARAMS, key, data as BufferSource))
}

export async function verifyData(
  key: CryptoKey,
  sig: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      SIGN_PARAMS,
      key,
      sig as BufferSource,
      data as BufferSource
    )
  } catch {
    return false
  }
}
