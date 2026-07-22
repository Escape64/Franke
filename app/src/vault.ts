// Файловый слой вольта (только Tauri): обычные .md на диске +
// скрытая папка .franke с CRDT-sidecar'ами (история Yjs на заметку).
import { homeDir } from '@tauri-apps/api/path'
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
  rename,
  watch,
  type WatchEvent,
  type UnwatchFn
} from '@tauri-apps/plugin-fs'

export const SIDECAR_DIR = '.franke'

/** Ошибки ФС уходят в лог Tauri (stdout tauri dev), чтобы не гасли молча. */
export async function logFsError(context: string, e: unknown): Promise<void> {
  console.error(context, e)
  try {
    const { error } = await import('@tauri-apps/plugin-log')
    await error(`${context}: ${e}`)
  } catch {
    /* вне Tauri или лог недоступен — достаточно console */
  }
}

let vaultRoot = ''

export function getVaultRoot(): string {
  return vaultRoot
}

/** Имя вольта = имя его папки (последний сегмент пути). */
export function vaultName(): string {
  return vaultRoot.slice(vaultRoot.replace(/\/+$/, '').lastIndexOf('/') + 1) || vaultRoot
}

const VAULT_PATH_KEY = 'franke-vault-path'
const RECENT_VAULTS_KEY = 'franke-recent-vaults'

/** Список недавних вольтов (пути), самый свежий — первым. */
export function recentVaults(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_VAULTS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function rememberVault(path: string) {
  const list = [path, ...recentVaults().filter((p) => p !== path)].slice(0, 8)
  localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(list))
  localStorage.setItem(VAULT_PATH_KEY, path)
}

/** Есть ли рядом папка .obsidian — значит это вольт Obsidian. Отказоустойчиво:
 * проблема доступа не должна ронять запуск, поэтому ошибку глотаем. */
export async function isObsidianVault(): Promise<boolean> {
  try {
    return await exists(`${vaultRoot}/.obsidian`)
  } catch {
    return false
  }
}

const WELCOME_NOTE = 'Добро пожаловать.md'
const WELCOME_TEXT = `# Добро пожаловать в Franke

Это ваша первая заметка. Файлы вольта — обычные .md на диске, можете открыть их любым редактором (в том числе Obsidian).

Правки, сделанные снаружи, приложение подхватит на лету.
`

/**
 * Инициализация активного вольта. Путь берётся из localStorage (ранее выбранный
 * пользователем), иначе — дефолтный ~/FrankeVault (создаётся при первом запуске
 * с приветственной заметкой). Приветствие пишем ТОЛЬКО в свежесозданный дефолт —
 * в чужую/существующую папку (в т.ч. вольт Obsidian) ничего не добавляем.
 */
export async function initVault(): Promise<string> {
  const saved = (() => {
    try {
      return localStorage.getItem(VAULT_PATH_KEY)
    } catch {
      return null
    }
  })()

  if (saved && (await exists(saved))) {
    return activateVault(saved)
  }

  const home = (await homeDir()).replace(/\/+$/, '')
  const def = `${home}/FrankeVault`
  const fresh = !(await exists(def))
  if (fresh) {
    await mkdir(def, { recursive: true })
    await writeTextFile(`${def}/${WELCOME_NOTE}`, WELCOME_TEXT)
  }
  return activateVault(def)
}

/** Переключить активный вольт на указанную папку (создаёт .franke при нужде). */
export async function activateVault(path: string): Promise<string> {
  vaultRoot = path.replace(/\/+$/, '')
  if (!(await exists(`${vaultRoot}/${SIDECAR_DIR}`))) {
    await mkdir(`${vaultRoot}/${SIDECAR_DIR}`, { recursive: true })
  }
  rememberVault(vaultRoot)
  return vaultRoot
}

/** Диалог выбора папки вольта. Возвращает путь или null (отмена). */
export async function pickVaultFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, multiple: false, title: 'Выберите папку вольта' })
  return typeof picked === 'string' ? picked : null
}

export function absPath(rel: string): string {
  return `${vaultRoot}/${rel}`
}

export function sidecarPath(rel: string): string {
  return `${vaultRoot}/${SIDECAR_DIR}/${rel}.crdt`
}

/** Абсолютный путь → путь относительно вольта (или null, если файл вне вольта). */
export function toRelPath(abs: string): string | null {
  if (!abs.startsWith(vaultRoot + '/')) return null
  return abs.slice(vaultRoot.length + 1)
}

export interface VaultEntries {
  folders: string[]
  notes: string[]
}

/** Полный листинг вольта: и папки (включая пустые), и .md-заметки. */
export async function listEntries(): Promise<VaultEntries> {
  const folders: string[] = []
  const notes: string[] = []
  const walk = async (dirAbs: string, relPrefix: string) => {
    for (const entry of await readDir(dirAbs)) {
      if (entry.name.startsWith('.')) continue
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        folders.push(rel)
        await walk(`${dirAbs}/${entry.name}`, rel)
      } else if (entry.name.endsWith('.md')) {
        notes.push(rel)
      }
    }
  }
  await walk(vaultRoot, '')
  folders.sort((a, b) => a.localeCompare(b, 'ru'))
  notes.sort((a, b) => a.localeCompare(b, 'ru'))
  return { folders, notes }
}

export async function listNotes(): Promise<string[]> {
  return (await listEntries()).notes
}

export async function createFolder(rel: string): Promise<void> {
  await mkdir(absPath(rel), { recursive: true })
}

/**
 * Перенос/переименование папки. Вместе с самой папкой переезжает её
 * поддерево в .franke (sidecar'ы и share-меты всех вложенных заметок) —
 * docId переезжают с файлами, совместные сессии вложенных заметок не рвутся.
 */
export async function moveFolder(oldRel: string, newRel: string): Promise<void> {
  await ensureParentDir(absPath(newRel))
  await rename(absPath(oldRel), absPath(newRel))
  const oldSide = `${vaultRoot}/${SIDECAR_DIR}/${oldRel}`
  if (await exists(oldSide)) {
    const newSide = `${vaultRoot}/${SIDECAR_DIR}/${newRel}`
    await ensureParentDir(newSide)
    await rename(oldSide, newSide)
  }
}

export async function readNote(rel: string): Promise<string | null> {
  try {
    return await readTextFile(absPath(rel))
  } catch (e) {
    void logFsError(`readNote(${rel})`, e)
    return null
  }
}

export async function writeNote(rel: string, text: string): Promise<void> {
  await ensureParentDir(absPath(rel))
  await writeTextFile(absPath(rel), text)
}

export async function readSidecar(rel: string): Promise<Uint8Array | null> {
  try {
    return await readFile(sidecarPath(rel))
  } catch {
    // Отсутствующий sidecar — норма для новой заметки, не логируем.
    return null
  }
}

export async function writeSidecar(rel: string, data: Uint8Array): Promise<void> {
  await ensureParentDir(sidecarPath(rel))
  await writeFile(sidecarPath(rel), data)
}

export async function createNote(rel: string): Promise<void> {
  await writeNote(rel, '')
}

export async function renameNote(oldRel: string, newRel: string): Promise<void> {
  await ensureParentDir(absPath(newRel))
  await rename(absPath(oldRel), absPath(newRel))
  if (await exists(sidecarPath(oldRel))) {
    await ensureParentDir(sidecarPath(newRel))
    await rename(sidecarPath(oldRel), sidecarPath(newRel))
  }
  if (await exists(shareMetaPath(oldRel))) {
    await ensureParentDir(shareMetaPath(newRel))
    await rename(shareMetaPath(oldRel), shareMetaPath(newRel))
  }
}

// --- Метаданные общего доступа (этапы 2 и 5) ---
// docId и ключи заметки хранятся у владельца рядом с sidecar'ом,
// НЕ в самом .md (иначе ключи утекли бы при любой пересылке файла).
// key — AES-ключ чтения; signPub/signPriv — пара ECDSA для права записи
// (могут отсутствовать в старой мете — апгрейдится при открытии).

export interface ShareMeta {
  docId: string
  key: string
  signPub?: string
  signPriv?: string
}

export function shareMetaPath(rel: string): string {
  return `${vaultRoot}/${SIDECAR_DIR}/${rel}.share.json`
}

export async function readShareMeta(rel: string): Promise<ShareMeta | null> {
  try {
    const meta = JSON.parse(await readTextFile(shareMetaPath(rel)))
    if (typeof meta.docId === 'string' && typeof meta.key === 'string') return meta
    return null
  } catch {
    return null // нет файла — заметка локальная
  }
}

export async function writeShareMeta(rel: string, meta: ShareMeta): Promise<void> {
  await ensureParentDir(shareMetaPath(rel))
  await writeTextFile(shareMetaPath(rel), JSON.stringify(meta))
}

async function ensureParentDir(fileAbs: string): Promise<void> {
  const dir = fileAbs.slice(0, fileAbs.lastIndexOf('/'))
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

/** Вотчер вольта; события sidecar-папки и не-md файлов отфильтровываются. */
export async function watchVault(
  onMdChange: (relPaths: string[]) => void
): Promise<UnwatchFn> {
  return watch(
    vaultRoot,
    (event: WatchEvent) => {
      const rels = event.paths
        .filter((p) => p.endsWith('.md') && !p.includes(`/${SIDECAR_DIR}/`))
        .map(toRelPath)
        .filter((p): p is string => p !== null)
      if (rels.length > 0) onMdChange(rels)
    },
    { recursive: true, delayMs: 300 }
  )
}
