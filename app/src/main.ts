import './style.css'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { isTauri } from '@tauri-apps/api/core'
import * as random from 'lib0/random'
import {
  inviteLink,
  openEncryptedRoom,
  openNote,
  openRoom,
  roomForNote,
  rotateShare,
  shareNote,
  sharedTitle,
  type NoteSession,
  type UserInfo
} from './collab'
import { initVault, listNotes, createNote, renameNote, watchVault } from './vault'
import {
  commentsMap,
  createThread,
  replyToThread,
  setThreadResolved,
  deleteThread,
  threadViews,
  type ThreadView
} from './comments'
import { commentsExtension, setCommentRanges } from './comments-editor'
import {
  attachMentionAutocomplete,
  mentions,
  participantNames,
  renderTextWithMentions
} from './mentions'
import {
  acceptSuggestion,
  createSuggestion,
  rejectSuggestion,
  suggestionsMap,
  suggestionViews,
  type SuggestionView
} from './suggestions'
import { suggestionsExtension, setSuggestRanges } from './suggestions-editor'
import { createVersion, listVersions, textAtVersion, type VersionView } from './versions'

const userColors = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ecd444', light: '#ecd44433' },
  { color: '#ee6352', light: '#ee635233' },
  { color: '#9ac2c9', light: '#9ac2c933' },
  { color: '#8acb88', light: '#8acb8833' },
  { color: '#1be7ff', light: '#1be7ff33' }
]
const defaultNames = ['Лиса', 'Сова', 'Ёж', 'Кит', 'Рысь', 'Барсук', 'Енот', 'Выдра']

const userColor = userColors[random.uint32() % userColors.length]
const user: UserInfo = {
  name:
    localStorage.getItem('franke-user-name') ??
    `${defaultNames[random.uint32() % defaultNames.length]}-${random.uint32() % 100}`,
  color: userColor.color,
  colorLight: userColor.light
}

// --- Каркас UI ---
const inTauri = isTauri()
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  ${
    inTauri
      ? `<aside id="sidebar">
           <div class="sidebar-head">
             <span>FrankeVault</span>
             <button id="new-note" title="Новая заметка">+</button>
           </div>
           <nav id="file-tree"></nav>
         </aside>`
      : ''
  }
  <div class="main">
    <header>
      <span class="logo">Franke</span>
      <span class="doc-name" id="doc-name"></span>
      ${inTauri ? '<button id="rename-note" title="Переименовать">✎</button>' : ''}
      ${inTauri ? '<button id="share-note" title="Поделиться заметкой">Поделиться</button>' : ''}
      <span class="spacer"></span>
      <button id="history-btn" title="История версий">🕐</button>
      <button id="mention-bell" class="hidden" title="Упоминания вас">🔔 <span id="mention-count">0</span></button>
      <span class="status" id="status"><span class="indicator"></span><span id="status-text">подключение…</span></span>
      <span class="user-badge">
        <span class="dot" style="background:${user.color}"></span>
        <input id="user-name" value="${user.name}" title="Ваше имя (видно другим участникам)" />
      </span>
    </header>
    <div class="work-row">
      <div class="editor-wrap"><div id="editor" style="display:contents"></div></div>
      <aside id="comments-panel" class="hidden">
        <div class="comments-head">
          <span>Обсуждение</span>
          <button id="comments-close" title="Скрыть">×</button>
        </div>
        <div id="suggestions-list"></div>
        <div id="comments-list"></div>
      </aside>
    </div>
  </div>
`

const docNameEl = document.querySelector<HTMLElement>('#doc-name')!
const statusEl = document.querySelector<HTMLElement>('#status')!
const statusText = document.querySelector<HTMLElement>('#status-text')!
const nameInput = document.querySelector<HTMLInputElement>('#user-name')!

nameInput.addEventListener('input', () => {
  const name = nameInput.value.trim() || user.name
  localStorage.setItem('franke-user-name', name)
  session?.awareness.setLocalStateField('user', { ...user, name })
})

document.querySelector('#history-btn')!.addEventListener('click', () => openHistoryModal())

// --- Текущая сессия и редактор ---
let session: NoteSession | null = null
let view: EditorView | null = null
let activeNote: string | null = null
// Переименовать активную заметку по новому имени; задаётся в vault-режиме.
let renameActive: ((newBase: string) => Promise<void>) | null = null

// Инлайн-редактирование названия прямо в шапке (дабл-клик по заголовку),
// как в сайдбаре. Прячем span, вставляем поле; Enter/клик-мимо — сохранить,
// Esc — отмена. Переименование выполняет renameActive (vault-режим).
let headerRenaming = false
function startHeaderRename() {
  if (headerRenaming || !session || !renameActive) return
  headerRenaming = true
  const current = docNameEl.textContent ?? ''
  const input = document.createElement('input')
  input.className = 'doc-name-input'
  input.value = current
  docNameEl.style.display = 'none'
  docNameEl.after(input)
  input.focus()
  input.select()
  let done = false
  const cleanup = () => {
    input.remove()
    docNameEl.style.display = ''
    headerRenaming = false
  }
  const commit = async () => {
    if (done) return
    done = true
    const val = input.value.trim()
    cleanup()
    if (val && val !== current) await renameActive!(val)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      done = true
      cleanup()
    }
  })
  input.addEventListener('blur', () => void commit())
}
// renameActive задан только в vault-режиме — у гостя переименования нет.
docNameEl.addEventListener('dblclick', () => startHeaderRename())

const renderStatus = () => {
  if (!session) return
  if (!session.provider) {
    statusEl.classList.remove('online')
    statusText.textContent = 'локальная заметка'
    return
  }
  const connected = session.provider.wsconnected
  const peers = session.awareness.getStates().size
  statusEl.classList.toggle('online', connected)
  const role = session.canWrite
    ? ''
    : session.canComment
      ? ' · комментирование'
      : ' · только чтение'
  statusText.textContent = connected
    ? `онлайн · участников: ${peers}${session.share ? ' · 🔒' : ''}${role}`
    : 'нет связи с relay'
}

const renderShareButton = () => {
  const btn = document.querySelector<HTMLButtonElement>('#share-note')
  if (!btn) return
  btn.textContent = session?.share ? 'Ссылка' : 'Поделиться'
}

// --- Список участников ---
// Клик по статусу («участников: N») открывает всплывашку с именами из awareness,
// живо обновляемую. Повторный клик / клик вне — закрыть.
let participantsPopover: HTMLElement | null = null

function closeParticipants() {
  participantsPopover?.remove()
  participantsPopover = null
}

function toggleParticipants() {
  if (participantsPopover) return closeParticipants()
  if (!session) return
  const pop = document.createElement('div')
  pop.className = 'participants-popover'

  const render = () => {
    const states = session!.awareness.getStates()
    const localId = session!.awareness.clientID
    const rows = [...states.entries()].map(([id, st]) => {
      const u = (st as { user?: { name?: string; color?: string } }).user ?? {}
      const me = id === localId ? ' <span class="participant-me">(вы)</span>' : ''
      return `<div class="participant"><span class="dot" style="background:${u.color ?? '#888'}"></span><span>${escapeHtml(u.name ?? 'аноним')}${me}</span></div>`
    })
    pop.innerHTML =
      `<div class="participants-head">Участники · ${states.size}</div>` +
      (rows.join('') || '<div class="participants-empty">пока никого</div>')
  }
  render()

  const r = statusEl.getBoundingClientRect()
  pop.style.top = `${r.bottom + 6}px`
  pop.style.left = `${r.left}px`
  document.body.appendChild(pop)
  participantsPopover = pop

  const onChange = () => participantsPopover && render()
  session.awareness.on('change', onChange)
  const onDocDown = (e: MouseEvent) => {
    if (pop.contains(e.target as Node) || statusEl.contains(e.target as Node)) return
    session?.awareness.off('change', onChange)
    document.removeEventListener('mousedown', onDocDown)
    closeParticipants()
  }
  setTimeout(() => document.addEventListener('mousedown', onDocDown), 0)
}

statusEl.style.cursor = 'pointer'
statusEl.title = 'Показать участников'
statusEl.addEventListener('click', toggleParticipants)

let detachComments: (() => void) | null = null
let detachSuggestions: (() => void) | null = null

async function activateSession(next: NoteSession, title: string) {
  if (view) view.destroy()
  if (detachComments) detachComments()
  if (detachSuggestions) detachSuggestions()
  if (session) await session.destroy()
  session = next
  docNameEl.textContent = title

  session.provider?.on('status', renderStatus)
  session.awareness.on('change', renderStatus)
  renderStatus()
  renderShareButton()

  const extensions: Extension[] = [
    basicSetup,
    markdown(),
    EditorView.lineWrapping,
    keymap.of(yUndoManagerKeymap),
    yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
    commentsExtension(
      {
        onOpenThread: (id) => openThreadInPanel(id),
        onSelectionComment: (from, to) => startNewComment(from, to),
        onSelectionSuggest: (from, to) => startNewSuggestion(from, to)
      },
      session.canComment // кнопки «Комментировать»/«Предложить» — и комментатору
    ),
    suggestionsExtension((id) => openSuggestionInPanel(id))
  ]
  // Правка текста — только редактору. Комментатору ставим лишь readOnly:
  // правки блокируются, но выделение работает (иначе кнопки «Комментировать»/
  // «Предложить», завязанные на выделение, не появятся). Читателю — полный
  // editable=false: ему выделять нечего.
  if (!session.canWrite) {
    extensions.push(EditorState.readOnly.of(true))
    if (!session.canComment) extensions.push(EditorView.editable.of(false))
  }

  view = new EditorView({
    state: EditorState.create({ doc: session.ytext.toString(), extensions }),
    parent: document.querySelector<HTMLDivElement>('#editor')!
  })

  detachComments = mountComments(next)
  detachSuggestions = mountSuggestions(next)
}

window.addEventListener('beforeunload', () => {
  void session?.destroy()
})

// Пересчёт декораций из Yjs-observer'ов нельзя диспатчить синхронно: observer
// срабатывает ВНУТРИ применения удалённого изменения к CodeMirror (yCollab),
// а вложенный view.dispatch падает с «update in progress». Откладываем на
// микротаск — он выполнится после завершения чужого update.
function safeDispatchEffects(effects: import('@codemirror/state').StateEffect<unknown>[]) {
  queueMicrotask(() => view?.dispatch({ effects }))
}

// --- Комментарии ---
// Панель тредов + подсветка. Данные в session.ydoc, поэтому пересчитываем при
// любом изменении карты комментариев и при правках текста (двигаются позиции).
let pendingComment: { from: number; to: number; quote: string } | null = null
let focusedThreadId: string | null = null
let showResolved = false
// Ключи прочитанных сообщений `${threadId}:${msgIndex}` — чтобы не считать
// уведомлением то, что пользователь уже видел.
let seenMessages = new Set<string>()

/** Имена для автодополнения и парсинга: онлайн-участники + авторы сообщений. */
function knownNames(): string[] {
  if (!session) return []
  const authors = threadViews(session.ydoc, session.ytext).flatMap((t) =>
    t.messages.map((m) => m.author)
  )
  return participantNames(session.awareness, authors)
}

function mountComments(sess: NoteSession): () => void {
  const { ydoc, ytext } = sess
  const cmap = commentsMap(ydoc)
  seenMessages = new Set()

  const refresh = () => {
    const views = threadViews(ydoc, ytext)
    safeDispatchEffects([setCommentRanges.of(views)])
    renderCommentsPanel(views)
    renderMentionBell(views)
  }

  const onChange = () => refresh()
  cmap.observeDeep(onChange)
  ytext.observe(onChange) // правки текста двигают абсолютные позиции якорей
  sess.awareness.on('change', onChange) // менялся список участников для @

  refresh()

  document.querySelector('#comments-close')!.addEventListener('click', hidePanel)

  return () => {
    cmap.unobserveDeep(onChange)
    ytext.unobserve(onChange)
    sess.awareness.off('change', onChange)
    pendingComment = null
    focusedThreadId = null
  }
}

// Непрочитанные упоминания текущего пользователя: сообщения с @моё-имя,
// написанные не мной и ещё не просмотренные.
function unreadMentionThreads(views: ThreadView[]): string[] {
  const me = currentUser().name
  const out: string[] = []
  for (const t of views) {
    t.messages.forEach((m, idx) => {
      const key = `${t.id}:${idx}`
      if (m.author !== me && mentions(m.text, me) && !seenMessages.has(key)) {
        out.push(t.id)
      }
    })
  }
  return [...new Set(out)]
}

function markThreadSeen(views: ThreadView[], threadId: string) {
  const t = views.find((v) => v.id === threadId)
  if (!t) return
  t.messages.forEach((_, idx) => seenMessages.add(`${threadId}:${idx}`))
}

function renderMentionBell(views: ThreadView[]) {
  const bell = document.querySelector<HTMLButtonElement>('#mention-bell')!
  const countEl = document.querySelector<HTMLElement>('#mention-count')!
  const unread = unreadMentionThreads(views)
  if (unread.length === 0) {
    bell.classList.add('hidden')
    return
  }
  bell.classList.remove('hidden')
  countEl.textContent = String(unread.length)
  bell.onclick = () => {
    openThreadInPanel(unread[0])
  }
}

// --- Предложения (suggest mode) ---
let pendingSuggestion: { from: number; to: number; oldText: string } | null = null

function mountSuggestions(sess: NoteSession): () => void {
  const { ydoc, ytext } = sess
  const smap = suggestionsMap(ydoc)

  // Новое предложение (в т.ч. прилетевшее от другого участника) должно быть
  // видно сразу: кнопки «Принять/Отклонить» живут в панели обсуждения, и без
  // автооткрытия редактор просто не знает, что предложение существует.
  // Открываем только при РОСТЕ числа предложений, чтобы не переоткрывать
  // панель, закрытую пользователем.
  let knownCount = 0
  const refresh = () => {
    const views = suggestionViews(ydoc, ytext)
    safeDispatchEffects([setSuggestRanges.of(views)])
    renderSuggestions(views)
    if (views.length > knownCount) showPanel()
    knownCount = views.length
  }

  const onChange = () => refresh()
  smap.observeDeep(onChange)
  ytext.observe(onChange)
  refresh()

  return () => {
    smap.unobserveDeep(onChange)
    ytext.unobserve(onChange)
    pendingSuggestion = null
  }
}

function startNewSuggestion(from: number, to: number) {
  if (!session) return
  pendingSuggestion = { from, to, oldText: session.ytext.toString().slice(from, to) }
  showPanel()
  renderSuggestions(suggestionViews(session.ydoc, session.ytext))
  const ta = document.querySelector<HTMLTextAreaElement>('#new-suggestion-text')
  ta?.focus()
  ta?.setSelectionRange(ta.value.length, ta.value.length)
}

function renderSuggestions(views: SuggestionView[]) {
  const list = document.querySelector<HTMLElement>('#suggestions-list')!
  list.innerHTML = ''

  if (pendingSuggestion) list.appendChild(suggestionComposer(pendingSuggestion.oldText))

  if (views.length > 0) {
    const header = document.createElement('div')
    header.className = 'suggestions-header'
    header.textContent = `Предложения (${views.length})`
    list.appendChild(header)
  }
  for (const s of views) list.appendChild(suggestionCard(s))
}

function suggestionComposer(oldText: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'suggest-card composer'
  const isInsert = oldText === ''
  box.innerHTML = `
    <div class="suggest-label">${isInsert ? 'Предложить вставку' : 'Предложить правку'}</div>
    ${oldText ? `<div class="suggest-old-preview">${escapeHtml(oldText)}</div>` : ''}
    <textarea id="new-suggestion-text" rows="2" placeholder="${isInsert ? 'Что вставить…' : 'Новый вариант (пусто = удалить)'}">${escapeHtml(oldText)}</textarea>
    <div class="comment-actions">
      <button class="btn-secondary" id="new-suggestion-cancel">Отмена</button>
      <button class="btn-primary" id="new-suggestion-send">Предложить</button>
    </div>
  `
  box.querySelector('#new-suggestion-cancel')!.addEventListener('click', () => {
    pendingSuggestion = null
    if (session) renderSuggestions(suggestionViews(session.ydoc, session.ytext))
  })
  box.querySelector('#new-suggestion-send')!.addEventListener('click', () => {
    if (!session || !pendingSuggestion) return
    const newText = box.querySelector<HTMLTextAreaElement>('#new-suggestion-text')!.value
    const u = currentUser()
    createSuggestion(session.ydoc, session.ytext, pendingSuggestion.from, pendingSuggestion.to, {
      author: u.name,
      color: u.color,
      newText
    })
    pendingSuggestion = null
    // refresh произойдёт по observer'у карты предложений
  })
  return box
}

function suggestionCard(s: SuggestionView): HTMLElement {
  const card = document.createElement('div')
  card.className = 'suggest-card'
  card.setAttribute('data-suggest-card', s.id)

  const head = document.createElement('div')
  head.className = 'comment-msg-head'
  head.innerHTML = `
    <span class="comment-author" style="color:${s.color}">${escapeHtml(s.author)} предлагает</span>
    <span class="comment-time">${fmtTime(s.ts)}</span>
  `
  card.appendChild(head)

  const diff = document.createElement('div')
  diff.className = 'suggest-diff'
  if (s.oldText) {
    const del = document.createElement('span')
    del.className = 'suggest-del'
    del.textContent = s.oldText
    diff.appendChild(del)
  }
  if (s.newText) {
    const ins = document.createElement('span')
    ins.className = 'suggest-ins'
    ins.textContent = s.newText
    diff.appendChild(ins)
  }
  if (!s.newText && s.oldText) {
    const note = document.createElement('span')
    note.className = 'suggest-note'
    note.textContent = ' (удалить)'
    diff.appendChild(note)
  }
  card.appendChild(diff)

  if (!session?.canComment) return card // читатель: только смотрит

  const actions = document.createElement('div')
  actions.className = 'comment-actions'
  // «Принять» применяет правку к тексту → только редактор (canWrite).
  // «Отклонить» лишь убирает предложение → доступно и комментатору.
  if (session.canWrite) {
    const accept = document.createElement('button')
    accept.className = 'btn-primary'
    accept.textContent = 'Принять'
    accept.onclick = () => session && acceptSuggestion(session.ydoc, session.ytext, s.id)
    actions.appendChild(accept)
  }
  const reject = document.createElement('button')
  reject.className = 'btn-secondary'
  reject.textContent = 'Отклонить'
  reject.onclick = () => session && rejectSuggestion(session.ydoc, s.id)
  actions.appendChild(reject)
  card.appendChild(actions)
  return card
}

// --- История версий ---
// Модалка со слайдером по чекпойнтам. Предпросмотр текста версии строится
// через Y.createDocFromSnapshot (документы создаются с gc:false, поэтому
// удалённый контент сохраняется и версии восстановимы). «Восстановить» —
// это forward-правка diff'ом: история не переписывается.

function fmtVersionTime(ts: number): string {
  return new Date(ts).toLocaleString('ru', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function openHistoryModal() {
  if (!session) return
  const { ydoc, ytext } = session
  const canWrite = session.canWrite

  // Чекпойнт текущего состояния, чтобы слайдер включал «сейчас»
  // (read-only не пишет в док — просто показываем существующие версии).
  if (canWrite) createVersion(ydoc, currentUser().name)
  const versions = listVersions(ydoc)
  if (versions.length === 0) {
    notify('История пока пуста — сделайте первую правку.')
    return
  }

  const overlay = document.createElement('div')
  overlay.className = 'history-overlay'
  overlay.innerHTML = `
    <div class="history-modal">
      <div class="history-head">
        <span>История версий</span>
        <button id="history-close" title="Закрыть">×</button>
      </div>
      <div class="history-meta">
        <span id="history-label"></span>
        <span id="history-pos"></span>
      </div>
      <input type="range" id="history-slider" min="0" max="${versions.length - 1}" value="${versions.length - 1}" />
      <pre id="history-preview"></pre>
      <div class="history-actions">
        <button class="btn-secondary" id="history-checkpoint">Сохранить текущую версию</button>
        <span class="spacer"></span>
        <button class="btn-primary" id="history-restore">Восстановить эту версию</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const slider = overlay.querySelector<HTMLInputElement>('#history-slider')!
  const label = overlay.querySelector<HTMLElement>('#history-label')!
  const pos = overlay.querySelector<HTMLElement>('#history-pos')!
  const preview = overlay.querySelector<HTMLElement>('#history-preview')!
  const restoreBtn = overlay.querySelector<HTMLButtonElement>('#history-restore')!

  let currentText: string | null = null

  const renderAt = (i: number) => {
    const v: VersionView = versions[i]
    currentText = textAtVersion(ydoc, v.snapshot)
    label.textContent = `${fmtVersionTime(v.ts)} · ${v.author}`
    pos.textContent = `версия ${i + 1} из ${versions.length}`
    preview.textContent = currentText ?? '(история этой версии недоступна)'
    const isLatest = i === versions.length - 1
    restoreBtn.disabled = isLatest || currentText === null || !canWrite
    restoreBtn.textContent = !canWrite
      ? 'Только чтение'
      : isLatest
        ? 'Это текущая версия'
        : 'Восстановить эту версию'
  }

  slider.addEventListener('input', () => renderAt(Number(slider.value)))
  renderAt(versions.length - 1)

  const close = () => overlay.remove()
  overlay.querySelector('#history-close')!.addEventListener('click', close)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  const checkpointBtn = overlay.querySelector<HTMLButtonElement>('#history-checkpoint')!
  checkpointBtn.disabled = !canWrite
  checkpointBtn.addEventListener('click', () => {
    if (!canWrite) return
    const saved = createVersion(ydoc, currentUser().name)
    close()
    if (saved) openHistoryModal() // переоткрыть со свежим списком
  })

  restoreBtn.addEventListener('click', () => {
    if (currentText === null || !session) return
    // Сначала чекпойнт текущего состояния — восстановление всегда обратимо.
    createVersion(ydoc, currentUser().name)
    const prev = ytext.toString()
    if (prev !== currentText) {
      // Простая замена diff'ом (общие префикс/суффикс).
      let start = 0
      const minLen = Math.min(prev.length, currentText.length)
      while (start < minLen && prev[start] === currentText[start]) start++
      let prevEnd = prev.length
      let nextEnd = currentText.length
      while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === currentText[nextEnd - 1]) {
        prevEnd--
        nextEnd--
      }
      ydoc.transact(() => {
        if (prevEnd > start) ytext.delete(start, prevEnd - start)
        if (nextEnd > start) ytext.insert(start, currentText!.slice(start, nextEnd))
      }, 'restore')
      createVersion(ydoc, currentUser().name)
    }
    close()
  })
}

function panelEl(): HTMLElement {
  return document.querySelector<HTMLElement>('#comments-panel')!
}

function showPanel() {
  panelEl().classList.remove('hidden')
}

function hidePanel() {
  panelEl().classList.add('hidden')
  pendingComment = null
  pendingSuggestion = null
  focusedThreadId = null
  if (session) {
    renderCommentsPanel(threadViews(session.ydoc, session.ytext))
    renderSuggestions(suggestionViews(session.ydoc, session.ytext))
  }
}

function startNewComment(from: number, to: number) {
  if (!session) return
  pendingComment = { from, to, quote: session.ytext.toString().slice(from, to) }
  showPanel()
  renderCommentsPanel(threadViews(session.ydoc, session.ytext))
  document.querySelector<HTMLTextAreaElement>('#new-comment-text')?.focus()
}

function openSuggestionInPanel(id: string) {
  showPanel()
  if (session) renderSuggestions(suggestionViews(session.ydoc, session.ytext))
  const card = document.querySelector(`[data-suggest-card="${id}"]`)
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function openThreadInPanel(id: string) {
  focusedThreadId = id
  showPanel()
  if (session) {
    const views = threadViews(session.ydoc, session.ytext)
    markThreadSeen(views, id) // просмотр треда гасит его уведомление
    renderCommentsPanel(views)
    renderMentionBell(views)
  }
  const card = document.querySelector(`[data-thread-card="${id}"]`)
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('ru', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function renderCommentsPanel(views: ThreadView[]) {
  const list = document.querySelector<HTMLElement>('#comments-list')!
  const openCount = views.filter((v) => !v.resolved).length
  const resolvedCount = views.length - openCount
  list.innerHTML = ''

  if (pendingComment) {
    list.appendChild(newCommentComposer(pendingComment.quote))
  }

  const visible = views.filter((v) => showResolved || !v.resolved)
  for (const t of visible) list.appendChild(threadCard(t))

  if (!pendingComment && views.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'comments-empty'
    empty.textContent = 'Выделите текст и нажмите «Комментировать», чтобы начать обсуждение.'
    list.appendChild(empty)
  }

  if (resolvedCount > 0) {
    const toggle = document.createElement('button')
    toggle.className = 'comments-toggle-resolved'
    toggle.textContent = showResolved
      ? `Скрыть решённые (${resolvedCount})`
      : `Показать решённые (${resolvedCount})`
    toggle.onclick = () => {
      showResolved = !showResolved
      renderCommentsPanel(views)
    }
    list.appendChild(toggle)
  }
  void openCount
}

function newCommentComposer(quote: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'comment-card composer'
  box.innerHTML = `
    <div class="comment-quote">${escapeHtml(quote)}</div>
    <textarea id="new-comment-text" placeholder="Ваш комментарий…" rows="3"></textarea>
    <div class="comment-actions">
      <button class="btn-secondary" id="new-comment-cancel">Отмена</button>
      <button class="btn-primary" id="new-comment-send">Отправить</button>
    </div>
  `
  const ta = box.querySelector<HTMLTextAreaElement>('#new-comment-text')!
  attachMentionAutocomplete(ta, knownNames)

  box.querySelector('#new-comment-cancel')!.addEventListener('click', () => {
    pendingComment = null
    if (session) renderCommentsPanel(threadViews(session.ydoc, session.ytext))
  })
  box.querySelector('#new-comment-send')!.addEventListener('click', () => {
    const text = box.querySelector<HTMLTextAreaElement>('#new-comment-text')!.value.trim()
    if (!text || !session || !pendingComment) return
    createThread(session.ydoc, session.ytext, pendingComment.from, pendingComment.to, msg(text))
    pendingComment = null
    // refresh произойдёт по observer'у карты комментариев
  })
  return box
}

function threadCard(t: ThreadView): HTMLElement {
  const card = document.createElement('div')
  card.className = 'comment-card' + (t.resolved ? ' resolved' : '')
  card.setAttribute('data-thread-card', t.id)
  if (t.id === focusedThreadId) card.classList.add('focused')

  const quote = document.createElement('div')
  quote.className = 'comment-quote'
  quote.textContent = t.quote
  card.appendChild(quote)

  const names = knownNames()
  const me = currentUser().name
  for (const m of t.messages) {
    const msg = document.createElement('div')
    msg.className = 'comment-msg'
    const head = document.createElement('div')
    head.className = 'comment-msg-head'
    head.innerHTML = `
      <span class="comment-author" style="color:${m.color}">${escapeHtml(m.author)}</span>
      <span class="comment-time">${fmtTime(m.ts)}</span>
    `
    const body = document.createElement('div')
    body.className = 'comment-text'
    body.appendChild(renderTextWithMentions(m.text, names, me))
    msg.append(head, body)
    card.appendChild(msg)
  }

  if (!session?.canComment) return card // читатель: без ответов и действий

  const actions = document.createElement('div')
  actions.className = 'comment-actions'
  const reply = document.createElement('input')
  reply.className = 'comment-reply'
  reply.placeholder = 'Ответить… (@ — упомянуть)'
  // Автодополнение вешаем ПЕРВЫМ: при открытом меню его Enter перехватит выбор
  // упоминания и остановит отправку ответа (stopImmediatePropagation).
  attachMentionAutocomplete(reply, knownNames)
  reply.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && reply.value.trim() && session) {
      replyToThread(session.ydoc, t.id, msg(reply.value.trim()))
      reply.value = ''
    }
  })
  const resolveBtn = document.createElement('button')
  resolveBtn.className = 'btn-secondary'
  resolveBtn.textContent = t.resolved ? 'Вернуть' : 'Решено'
  resolveBtn.onclick = () => session && setThreadResolved(session.ydoc, t.id, !t.resolved)
  const delBtn = document.createElement('button')
  delBtn.className = 'btn-secondary'
  delBtn.textContent = 'Удалить'
  delBtn.onclick = () => session && deleteThread(session.ydoc, t.id)

  actions.append(reply, resolveBtn, delBtn)
  card.appendChild(actions)
  return card
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

// Скачать текущий текст заметки как .md (работает и у гостя без вольта).
function downloadCurrentNote(filename: string) {
  if (!session) return
  const blob = new Blob([session.ytext.toString()], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Оверлей «подключаемся к документу» поверх редактора для гостя.
 * Пока он висит — гость не может печатать в ещё пустой документ (иначе его
 * ввод склеился бы с контентом владельца, который придёт секундой позже).
 * Снимается по первому synced либо по таймауту (владелец офлайн — тогда
 * гость работает с пустым/локально-кэшированным документом и доливается позже).
 */
function showGuestLoadingOverlay(sess: NoteSession) {
  const wrap = document.querySelector<HTMLElement>('.editor-wrap')!
  const overlay = document.createElement('div')
  overlay.className = 'guest-overlay'
  overlay.innerHTML = '<div class="spinner"></div><span>Подключаемся к общему документу…</span>'
  wrap.appendChild(overlay)

  let done = false
  const finish = (offline: boolean) => {
    if (done) return
    done = true
    if (offline) {
      // Владелец недоступен и на relay нет журнала — не блокируем ввод дальше.
      overlay.querySelector('span')!.textContent =
        'Владелец офлайн. Пишите — правки сохранятся локально и отправятся позже.'
      overlay.classList.add('dismissable')
      overlay.addEventListener('click', () => overlay.remove())
      setTimeout(() => overlay.remove(), 3500)
    } else {
      overlay.remove()
    }
  }
  // Гость всегда на EncryptedRelayProvider (есть событие 'synced'); объединённый
  // тип провайдера сужается до 'status', поэтому точечное приведение.
  ;(sess.provider as unknown as { on(e: 'synced', h: () => void): void } | null)?.on(
    'synced',
    () => finish(false)
  )
  setTimeout(() => finish(true), 4000)
}

// Панель гостя: онбординг + апселл. Строится только на маршруте /d/.
function mountGuestPanel() {
  const main = document.querySelector<HTMLElement>('.main')!
  const bar = document.createElement('div')
  bar.className = 'guest-bar'
  bar.innerHTML = `
    <span class="guest-hint">Вы редактируете общую заметку в браузере. Правки сохраняются локально и синхронизируются с владельцем — ничего не установлено.</span>
    <span class="guest-actions">
      <button id="guest-download">Скачать .md</button>
      <button id="guest-install">Сделать своей копией</button>
    </span>
  `
  main.insertBefore(bar, main.querySelector('.work-row'))

  document.querySelector('#guest-download')!.addEventListener('click', () => {
    downloadCurrentNote(docNameEl.textContent || 'franke-заметка')
  })
  document.querySelector('#guest-install')!.addEventListener('click', () => {
    // Пока без deep-link «открыть эту заметку в приложении» — просто ведём
    // на скачивание; заметку можно забрать кнопкой «Скачать .md».
    window.open(RELEASES_URL, '_blank', 'noopener')
  })
}

// Модальное подтверждение (замена confirm(), не работающего в вебвью Tauri).
function askConfirm(message: string, okLabel = 'Продолжить'): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'history-overlay'
    overlay.innerHTML = `
      <div class="history-modal ask-modal">
        <p class="ask-message">${message}</p>
        <div class="history-actions">
          <span class="spacer"></span>
          <button class="btn-secondary" data-ask="cancel">Отмена</button>
          <button class="btn-primary" data-ask="ok">${okLabel}</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      overlay.remove()
      resolve(v)
    }
    overlay.querySelector('[data-ask="ok"]')!.addEventListener('click', () => finish(true))
    overlay.querySelector('[data-ask="cancel"]')!.addEventListener('click', () => finish(false))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false)
    })
  })
}

// Короткое уведомление (замена alert()).
function notify(message: string): void {
  const overlay = document.createElement('div')
  overlay.className = 'history-overlay'
  overlay.innerHTML = `
    <div class="history-modal ask-modal">
      <p class="ask-message">${message}</p>
      <div class="history-actions">
        <span class="spacer"></span>
        <button class="btn-primary" data-ask="ok">ОК</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.querySelector('[data-ask="ok"]')!.addEventListener('click', close)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
}

// --- Диалог «Поделиться»: две ссылки + отзыв доступа ---
// Копирование в буфер: clipboard API, с фолбэком на execCommand для вебвью,
// где clipboard может быть недоступен вне «безопасного» контекста.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

function openShareDialog(
  meta: import('./vault').ShareMeta,
  onRotate: () => Promise<import('./vault').ShareMeta>
) {
  const overlay = document.createElement('div')
  overlay.className = 'history-overlay'
  const render = (m: import('./vault').ShareMeta) => {
    overlay.innerHTML = `
      <div class="history-modal share-modal">
        <div class="history-head">
          <span>Поделиться заметкой</span>
          <button id="share-close" title="Закрыть">×</button>
        </div>
        <label class="share-label">Ссылка для редактирования</label>
        <div class="share-row">
          <input class="share-link" readonly value="${inviteLink(m, 'write')}" />
          <button class="btn-secondary share-copy">Копировать</button>
        </div>
        <label class="share-label">Ссылка для комментирования</label>
        <div class="share-row">
          <input class="share-link" readonly value="${inviteLink(m, 'comment')}" />
          <button class="btn-secondary share-copy">Копировать</button>
        </div>
        <label class="share-label">Ссылка только для чтения</label>
        <div class="share-row">
          <input class="share-link" readonly value="${inviteLink(m, 'read')}" />
          <button class="btn-secondary share-copy">Копировать</button>
        </div>
        <p class="share-hint">Ключи в части после # не попадают на сервер. Комментатор может оставлять комментарии и предлагать правки, но не редактировать текст напрямую. Читатель видит документ и курсоры, но ничего не меняет.</p>
        <div class="history-actions">
          <button class="btn-secondary" id="share-rotate">Отозвать доступ (сменить ссылки)</button>
        </div>
      </div>
    `
    overlay.querySelector('#share-close')!.addEventListener('click', () => overlay.remove())
    overlay.querySelectorAll<HTMLInputElement>('.share-link').forEach((inp) =>
      inp.addEventListener('focus', () => inp.select())
    )
    overlay.querySelectorAll<HTMLButtonElement>('.share-copy').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const input = btn.previousElementSibling as HTMLInputElement
        const ok = await copyText(input.value)
        const orig = btn.textContent
        btn.textContent = ok ? 'Скопировано ✓' : 'Не вышло'
        btn.classList.toggle('copied', ok)
        setTimeout(() => {
          btn.textContent = orig
          btn.classList.remove('copied')
        }, 1500)
      })
    })
    overlay.querySelector('#share-rotate')!.addEventListener('click', async () => {
      const ok = await askConfirm(
        'Старые ссылки перестанут получать новые правки, у заметки появятся новые ссылки. Продолжить?',
        'Отозвать'
      )
      if (!ok) return
      const fresh = await onRotate()
      render(fresh)
    })
  }
  render(meta)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
}

// --- Режим браузера ---
// Ссылка-приглашение: ?d=<docId>#<readKey>.<signPub>[.<signPriv>] (прод —
// query работает на любом статик-хостинге) или старый путь /d/<docId> (dev).
// ?room=... остаётся как plaintext dev-демо; без параметров — лендинг.
async function startBrowserMode() {
  const params = new URLSearchParams(location.search)
  const fromQuery = params.get('d')
  const fromPath = location.pathname.match(/\/d\/([A-Za-z0-9_-]+)$/)?.[1]
  const docId = fromQuery && /^[A-Za-z0-9_-]+$/.test(fromQuery) ? fromQuery : fromPath
  if (docId) {
    const keyB64 = location.hash.slice(1)
    if (!keyB64) {
      docNameEl.textContent = 'в ссылке нет ключа расшифровки (часть после #)'
      return
    }
    let guest: NoteSession
    try {
      guest = await openEncryptedRoom(docId, keyB64, currentUser())
    } catch (e) {
      docNameEl.textContent =
        e instanceof Error && e.message === 'legacy-link'
          ? 'ссылка устаревшего формата — попросите у владельца новую'
          : `не удалось открыть документ: ${e}`
      return
    }
    const roleSuffix = guest.canWrite
      ? ''
      : guest.canComment
        ? ' (комментирование)'
        : ' (чтение)'
    await activateSession(guest, `общая заметка${roleSuffix}`)
    mountGuestPanel()
    showGuestLoadingOverlay(guest)
    // Название заметки владелец кладёт в общий документ — показываем его,
    // как только оно синхронизируется (до тех пор — заглушка выше).
    const suffix = roleSuffix
    const applyTitle = () => {
      const t = sharedTitle(guest.ydoc)
      if (t) docNameEl.textContent = t + suffix
    }
    guest.ydoc.getMap('meta').observe(applyTitle)
    applyTitle()
    return
  }
  const roomParam = params.get('room')
  if (roomParam === null) {
    mountLanding()
    return
  }
  // ?room=note:Мой файл.md → комната dev-демо по пути
  // (URLSearchParams уже декодировал параметр, кодируем путь заново).
  let room = roomParam || 'franke-demo'
  if (room.startsWith('note:')) room = roomForNote(room.slice('note:'.length))
  await activateSession(openRoom(room, currentUser()), room)
}

// --- Лендинг (браузер без параметров): что это и где скачать ---
const RELEASES_URL = 'https://github.com/Escape64/Franke/releases/latest'

function mountLanding() {
  document.title = 'Franke — локальные заметки с живой коллаборацией'
  app.innerHTML = `
    <div class="landing">
      <div class="landing-card">
        <div class="landing-logo">Franke</div>
        <p class="landing-tagline">Заметки, которые живут у вас на диске, — с совместным редактированием в реальном времени. Без облака: всё, что уходит в сеть, зашифровано, и прочитать это можем только вы и те, с кем вы поделились.</p>
        <div class="landing-downloads">
          <a class="landing-btn" href="${RELEASES_URL}">⬇ macOS (.dmg)</a>
          <a class="landing-btn" href="${RELEASES_URL}">⬇ Windows (.exe)</a>
          <a class="landing-btn" href="${RELEASES_URL}">⬇ Linux (.AppImage / .deb)</a>
        </div>
        <p class="landing-note">macOS при первом запуске: правый клик по приложению → «Открыть» (сборка пока без подписи Apple). Windows: «Подробнее» → «Выполнить в любом случае».</p>
        <p class="landing-guest">Получили ссылку на заметку? Просто откройте её — редактор работает прямо в браузере, устанавливать ничего не нужно.</p>
        <p class="landing-links"><a href="https://github.com/Escape64/Franke">GitHub</a> · relay можно поднять свой: <code>docker compose up -d</code></p>
      </div>
    </div>
  `
}

// --- Режим Tauri: вольт на диске ---
async function startVaultMode() {
  await initVault()
  const treeEl = document.querySelector<HTMLElement>('#file-tree')!

  // Заметка, которую сейчас переименовывают инлайн (двойным кликом). Хранится
  // как состояние, чтобы перерисовка дерева не сбивала поле ввода.
  let renamingRel: string | null = null

  const refreshTree = async () => {
    const notes = await listNotes()
    treeEl.innerHTML = ''
    let lastFolder = ''
    for (const rel of notes) {
      const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      if (folder && folder !== lastFolder) {
        const f = document.createElement('div')
        f.className = 'tree-folder'
        f.textContent = folder
        treeEl.appendChild(f)
      }
      lastFolder = folder
      const indent = `${12 + (rel.split('/').length - 1) * 14}px`
      const base = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '')

      if (rel === renamingRel) {
        // Инлайн-редактирование имени прямо в дереве (как в Obsidian/Claude).
        const input = document.createElement('input')
        input.className = 'tree-rename-input'
        input.style.paddingLeft = indent
        input.value = base
        let done = false
        const commit = () => {
          if (done) return
          done = true
          void doRename(rel, input.value)
        }
        const cancel = () => {
          if (done) return
          done = true
          renamingRel = null
          void refreshTree()
        }
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        })
        input.addEventListener('blur', commit)
        treeEl.appendChild(input)
        queueMicrotask(() => {
          input.focus()
          input.select()
        })
      } else {
        const item = document.createElement('button')
        item.className = 'tree-item' + (rel === activeNote ? ' active' : '')
        item.style.paddingLeft = indent
        item.textContent = base
        item.addEventListener('click', () => void open(rel))
        item.addEventListener('dblclick', (e) => {
          e.preventDefault()
          renamingRel = rel
          void refreshTree()
        })
        treeEl.appendChild(item)
      }
    }
  }

  // Переименование двигает вместе с .md и sidecar, и share.json, поэтому
  // docId (адрес комнаты) переезжает с файлом — совместная сессия не рвётся
  // (владелец лишь на миг переподключается). Сохраняем папку-родителя, .md.
  const doRename = async (oldRel: string, rawName: string) => {
    renamingRel = null
    const dir = oldRel.includes('/') ? oldRel.slice(0, oldRel.lastIndexOf('/') + 1) : ''
    const clean = rawName.trim().replace(/\.md$/, '')
    if (!clean) return void refreshTree()
    const newRel = `${dir}${clean}.md`
    if (newRel === oldRel) return void refreshTree()
    const wasActive = oldRel === activeNote
    if (wasActive) {
      activeNote = null
      await session?.destroy()
      session = null
    }
    await renameNote(oldRel, newRel)
    await refreshTree()
    if (wasActive) await open(newRel)
  }

  // Дабл-клик по заголовку в шапке переименовывает активную заметку.
  renameActive = async (newBase: string) => {
    if (activeNote) await doRename(activeNote, newBase)
  }

  const open = async (rel: string) => {
    if (rel === activeNote) return
    activeNote = rel
    await activateSession(await openNote(rel, currentUser()), rel.replace(/\.md$/, ''))
    await refreshTree()
  }

  document.querySelector('#new-note')!.addEventListener('click', async () => {
    // Как в Obsidian: создаём «Без названия» (потом «Без названия 1», …) и сразу
    // открываем — без диалога. Переименовать можно кнопкой ✎ по желанию.
    const notes = await listNotes()
    const taken = new Set(
      notes.filter((r) => !r.includes('/')).map((r) => r.replace(/\.md$/, ''))
    )
    const base = 'Без названия'
    let name = base
    for (let n = 1; taken.has(name); n++) name = `${base} ${n}`
    const rel = `${name}.md`
    await createNote(rel)
    await refreshTree()
    await open(rel)
  })

  document.querySelector('#share-note')!.addEventListener('click', async () => {
    if (!activeNote || !session) return
    let meta = session.share
    if (!meta) {
      meta = await shareNote(activeNote)
      // Переоткрываем сессию: у заметки появился сетевой провайдер.
      const rel = activeNote
      activeNote = null
      await open(rel)
      meta = session!.share!
    }
    openShareDialog(meta, async () => {
      // Ротация: новые docId и ключи, переоткрытие → полное состояние
      // зальётся в новую комнату, старые ссылки замирают.
      const rel = activeNote!
      const fresh = await rotateShare(rel)
      activeNote = null
      await open(rel)
      return fresh
    })
  })

  // Кнопка ✎ — запасной путь к тому же инлайн-переименованию активной заметки.
  document.querySelector('#rename-note')!.addEventListener('click', () => {
    if (!activeNote) return
    renamingRel = activeNote
    void refreshTree()
  })

  await watchVault(async (changedRels) => {
    if (activeNote && changedRels.includes(activeNote)) {
      const { readNote } = await import('./vault')
      const text = await readNote(activeNote)
      if (text !== null) session?.reconcileFromDisk(text)
    }
    await refreshTree()
  })

  const notes = await listNotes()
  await open(notes[0] ?? 'Добро пожаловать.md')
}

function currentUser(): UserInfo {
  return { ...user, name: nameInput.value.trim() || user.name }
}

// Сообщение комментария от текущего пользователя.
function msg(text: string) {
  const u = currentUser()
  return { author: u.name, color: u.color, text, ts: Date.now() }
}

if (inTauri) {
  // Ошибки вебвью — в stdout tauri dev, иначе они не видны снаружи окна.
  void import('@tauri-apps/plugin-log').then(({ error }) => {
    window.addEventListener('error', (e) => void error(`window.onerror: ${e.message}`))
    window.addEventListener('unhandledrejection', (e) =>
      void error(`unhandledrejection: ${e.reason?.stack ?? e.reason}`)
    )
  })
}

// Автообновление (только Tauri): при старте спрашиваем GitHub Releases.
// Диалоги свои (askConfirm/notify) — в WKWebView нет confirm/alert. Плагины
// импортируются динамически, чтобы не попадать в браузерный бандл гостя.
async function checkForUpdates() {
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) return
  const ok = await askConfirm(
    `Вышла новая версия Franke ${update.version}. Установить сейчас? Заметки не пострадают.`,
    'Обновить'
  )
  if (!ok) return
  await update.downloadAndInstall()
  const { relaunch } = await import('@tauri-apps/plugin-process')
  if (await askConfirm('Обновление установлено. Перезапустить приложение?', 'Перезапустить')) {
    await relaunch()
  }
}

if (inTauri) {
  // Молча при любой ошибке: нет сети, релизов ещё нет, endpoint недоступен —
  // обновление не должно мешать работе с заметками.
  void checkForUpdates().catch(() => {})
}

void (inTauri ? startVaultMode() : startBrowserMode()).catch(async (e) => {
  docNameEl.textContent = `ошибка запуска: ${e}`
  const { logFsError } = await import('./vault')
  void logFsError('startup', e)
})
