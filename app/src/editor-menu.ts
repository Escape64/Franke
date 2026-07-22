// Контекстное меню редактора (right-click) в духе Obsidian: форматирование,
// абзац, вставка. Меню строится в DOM (WKWebView не даёт полезного нативного),
// поддерживает один уровень вложенных подменю. Гейт на readOnly — читателю и
// комментатору меню правки текста не показываем.
import { EditorView } from '@codemirror/view'
import {
  wrapSelection,
  toggleLinePrefix,
  setHeading,
  insertLink,
  insertTable,
  insertHr,
  insertCodeBlock,
  clearFormatting
} from './editor-commands'

interface MenuItem {
  label?: string
  shortcut?: string
  run?: (view: EditorView) => void
  submenu?: MenuItem[]
  separator?: boolean
}

const isMac = navigator.platform.toUpperCase().includes('MAC')
const mod = isMac ? '⌘' : 'Ctrl+'

function rootItems(): MenuItem[] {
  return [
    {
      label: 'Форматирование',
      submenu: [
        { label: 'Жирный', shortcut: `${mod}B`, run: (v) => wrapSelection(v, '**') },
        { label: 'Курсив', shortcut: `${mod}I`, run: (v) => wrapSelection(v, '*') },
        { label: 'Зачёркивание', run: (v) => wrapSelection(v, '~~') },
        { label: 'Код', run: (v) => wrapSelection(v, '`') },
        { separator: true },
        { label: 'Очистить форматирование', run: clearFormatting }
      ]
    },
    {
      label: 'Абзац',
      submenu: [
        { label: 'Список', run: (v) => toggleLinePrefix(v, '- ') },
        { label: 'Нумерованный список', run: (v) => toggleLinePrefix(v, '1. ') },
        { label: 'Список задач', run: (v) => toggleLinePrefix(v, '- [ ] ') },
        { separator: true },
        ...[1, 2, 3, 4, 5, 6].map((l) => ({
          label: `Заголовок ${l}`,
          run: (v: EditorView) => setHeading(v, l)
        })),
        { label: 'Убрать заголовок', run: (v) => setHeading(v, 0) },
        { separator: true },
        { label: 'Цитата', run: (v) => toggleLinePrefix(v, '> ') }
      ]
    },
    {
      label: 'Вставка',
      submenu: [
        { label: 'Ссылка', run: insertLink },
        { label: 'Таблица', run: insertTable },
        { label: 'Блок кода', run: insertCodeBlock },
        { label: 'Горизонтальная линия', run: insertHr }
      ]
    }
  ]
}

let openMenus: HTMLElement[] = []

function closeAll() {
  for (const m of openMenus) m.remove()
  openMenus = []
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKey, true)
}

function onDocDown(e: MouseEvent) {
  if (openMenus.some((m) => m.contains(e.target as Node))) return
  closeAll()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeAll()
}

// x,y — точка появления (для корня) или правый край пункта (для подменю);
// altX — левый край пункта, чтобы подменю отразилось влево при нехватке места.
function buildMenu(
  view: EditorView,
  items: MenuItem[],
  x: number,
  y: number,
  depth: number,
  altX?: number
): HTMLElement {
  // Закрыть подменю глубже текущего уровня
  openMenus = openMenus.filter((m) => {
    if (Number(m.dataset.depth) >= depth) {
      m.remove()
      return false
    }
    return true
  })

  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.dataset.depth = String(depth)

  for (const it of items) {
    if (it.separator) {
      const hr = document.createElement('div')
      hr.className = 'ctx-sep'
      menu.appendChild(hr)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'ctx-item'
    const tail = it.shortcut
      ? `<span class="ctx-shortcut">${it.shortcut}</span>`
      : it.submenu
        ? `<span class="ctx-chevron">›</span>`
        : ''
    btn.innerHTML = `<span>${it.label}</span>${tail}`
    if (it.submenu) {
      const openSub = () => {
        const r = btn.getBoundingClientRect()
        buildMenu(view, it.submenu!, r.right - 4, r.top - 4, depth + 1, r.left)
      }
      btn.addEventListener('mouseenter', openSub)
      btn.addEventListener('click', openSub)
    } else {
      // Наведение на лист закрывает глубже открытые подменю
      btn.addEventListener('mouseenter', () => {
        openMenus = openMenus.filter((m) => {
          if (Number(m.dataset.depth) > depth) {
            m.remove()
            return false
          }
          return true
        })
      })
      btn.addEventListener('click', () => {
        it.run?.(view)
        closeAll()
      })
    }
    menu.appendChild(btn)
  }

  document.body.appendChild(menu)

  // Позиционирование с зажимом в вьюпорт
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let px = x
  let py = y
  if (px + mw > window.innerWidth - 8) {
    px = altX !== undefined ? altX - mw : window.innerWidth - mw - 8
  }
  if (px < 8) px = 8
  if (py + mh > window.innerHeight - 8) py = Math.max(8, window.innerHeight - mh - 8)
  menu.style.left = `${px}px`
  menu.style.top = `${py}px`

  openMenus.push(menu)
  return menu
}

function showEditorMenu(view: EditorView, x: number, y: number) {
  closeAll()
  buildMenu(view, rootItems(), x, y, 0)
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKey, true)
}

export function editorContextMenu() {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      if (view.state.readOnly) return false
      event.preventDefault()
      // Правый клик вне текущего выделения ставит курсор на место клика,
      // чтобы заголовок/цитата применились к нужной строке.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos != null) {
        const sel = view.state.selection.main
        const inside = !sel.empty && pos >= sel.from && pos <= sel.to
        if (!inside) view.dispatch({ selection: { anchor: pos } })
      }
      showEditorMenu(view, event.clientX, event.clientY)
      return true
    }
  })
}
