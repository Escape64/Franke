// Отрисовка предложений в CodeMirror: старый диапазон зачёркнут (red),
// после него — виджет с предлагаемым новым текстом (green). Данные приходят
// снаружи через эффект setSuggestRanges (пересчёт из Y.Doc в main.ts).
import { EditorView, Decoration, type DecorationSet, WidgetType } from '@codemirror/view'
import { StateField, StateEffect } from '@codemirror/state'
import type { SuggestionView } from './suggestions'

export const setSuggestRanges = StateEffect.define<SuggestionView[]>()

class NewTextWidget extends WidgetType {
  constructor(
    private text: string,
    private id: string
  ) {
    super()
  }
  eq(other: NewTextWidget): boolean {
    return other.text === this.text && other.id === this.id
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-suggest-new'
    span.dataset.suggest = this.id
    span.textContent = this.text
    return span
  }
  ignoreEvent(): boolean {
    return false
  }
}

const suggestField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setSuggestRanges)) {
        const decos = []
        for (const s of [...e.value].sort((a, b) => a.from - b.from)) {
          // Зачёркиваем старый текст (для удаления/замены).
          if (s.to > s.from) {
            decos.push(
              Decoration.mark({
                class: 'cm-suggest-old',
                attributes: { 'data-suggest': s.id }
              }).range(s.from, s.to)
            )
          }
          // Виджет с новым текстом (для вставки/замены).
          if (s.newText) {
            decos.push(
              Decoration.widget({
                widget: new NewTextWidget(s.newText, s.id),
                side: 1
              }).range(s.to)
            )
          }
        }
        deco = Decoration.set(decos, true)
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

export function suggestionsExtension(onOpen?: (id: string) => void) {
  if (!onOpen) return [suggestField]
  // Клик по зачёркнутому тексту или зелёному виджету открывает панель
  // обсуждения на карточке этого предложения (паритет с комментариями).
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event) {
      const el = (event.target as HTMLElement).closest('[data-suggest]')
      if (!(el instanceof HTMLElement) || !el.dataset.suggest) return false
      onOpen(el.dataset.suggest)
      return true
    }
  })
  return [suggestField, clickHandler]
}
