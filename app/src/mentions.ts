// Упоминания @имя в комментариях. Список имён берётся из awareness (активные
// участники) плюс авторы уже написанных сообщений — чтобы упоминание
// подсвечивалось, даже если человек сейчас офлайн.
import type { Awareness } from 'y-protocols/awareness'

/** Уникальные имена участников: сейчас онлайн + все, кто уже писал. */
export function participantNames(awareness: Awareness, extra: string[] = []): string[] {
  const names = new Set<string>(extra)
  for (const st of awareness.getStates().values()) {
    const name = (st as { user?: { name?: string } }).user?.name
    if (name) names.add(name)
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ru'))
}

/**
 * Разбить текст на фрагменты, выделив упоминания. Матчим по точному вхождению
 * «@» + известное имя (имена сортируем по длине убыв., чтобы «@Аня Б» имело
 * приоритет над «@Аня»). Возвращаем DOM-фрагмент для безопасной вставки.
 */
export function renderTextWithMentions(
  text: string,
  names: string[],
  myName: string
): DocumentFragment {
  const frag = document.createDocumentFragment()
  const sorted = [...names].sort((a, b) => b.length - a.length)
  let i = 0
  while (i < text.length) {
    if (text[i] === '@') {
      const hit = sorted.find((n) => text.startsWith('@' + n, i))
      if (hit) {
        const chip = document.createElement('span')
        chip.className = 'mention' + (hit === myName ? ' me' : '')
        chip.textContent = '@' + hit
        frag.appendChild(chip)
        i += hit.length + 1
        continue
      }
    }
    // Копим обычный текст до следующего '@'.
    let j = text.indexOf('@', i + 1)
    if (j === -1) j = text.length
    frag.appendChild(document.createTextNode(text.slice(i, j)))
    i = j
  }
  return frag
}

/** Есть ли в тексте упоминание конкретного имени. */
export function mentions(text: string, name: string): boolean {
  return text.includes('@' + name)
}

/**
 * Автодополнение @имя для textarea/input. При вводе «@» + префикс показывает
 * выпадающий список; стрелки/Enter/клик выбирают, Esc закрывает.
 */
export function attachMentionAutocomplete(
  input: HTMLTextAreaElement | HTMLInputElement,
  getNames: () => string[]
): void {
  let menu: HTMLElement | null = null
  let items: string[] = []
  let active = 0

  const close = () => {
    menu?.remove()
    menu = null
    items = []
  }

  // Префикс после последнего '@' перед курсором (без пробелов).
  const currentPrefix = (): { at: number; prefix: string } | null => {
    const pos = input.selectionStart ?? input.value.length
    const upto = input.value.slice(0, pos)
    const at = upto.lastIndexOf('@')
    if (at === -1) return null
    const between = upto.slice(at + 1)
    if (/\s/.test(between)) return null // пробел закрыл упоминание
    return { at, prefix: between }
  }

  const pick = (name: string) => {
    const ctx = currentPrefix()
    if (!ctx) return
    const pos = input.selectionStart ?? input.value.length
    const before = input.value.slice(0, ctx.at)
    const after = input.value.slice(pos)
    const inserted = `@${name} `
    input.value = before + inserted + after
    const caret = before.length + inserted.length
    input.setSelectionRange(caret, caret)
    input.focus()
    close()
  }

  const render = () => {
    close()
    const ctx = currentPrefix()
    if (!ctx) return
    const q = ctx.prefix.toLowerCase()
    items = getNames().filter((n) => n.toLowerCase().startsWith(q))
    if (items.length === 0) return
    active = 0
    menu = document.createElement('div')
    menu.className = 'mention-menu'
    items.forEach((name, idx) => {
      const el = document.createElement('div')
      el.className = 'mention-option' + (idx === active ? ' active' : '')
      el.textContent = name
      el.onmousedown = (e) => {
        e.preventDefault()
        pick(name)
      }
      menu!.appendChild(el)
    })
    document.body.appendChild(menu)
    positionMenu()
  }

  const positionMenu = () => {
    if (!menu) return
    const r = input.getBoundingClientRect()
    menu.style.left = `${r.left}px`
    menu.style.top = `${r.bottom + 4}px`
    menu.style.minWidth = `${Math.min(r.width, 220)}px`
  }

  const highlight = () => {
    if (!menu) return
    ;[...menu.children].forEach((c, i) =>
      c.classList.toggle('active', i === active)
    )
  }

  input.addEventListener('input', render)
  ;(input as HTMLElement).addEventListener('keydown', (e: KeyboardEvent) => {
    if (!menu) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      active = (active + 1) % items.length
      highlight()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = (active - 1 + items.length) % items.length
      highlight()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Останавливаем и другие keydown-обработчики на этом же поле (напр.
      // отправку ответа по Enter) — Enter здесь выбирает упоминание.
      e.stopImmediatePropagation()
      pick(items[active])
    } else if (e.key === 'Escape') {
      close()
    }
  })
  input.addEventListener('blur', () => setTimeout(close, 150))
}
