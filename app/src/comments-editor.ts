// Расширение CodeMirror для комментариев: подсветка диапазонов с тредами и
// связь редактора с моделью (comments.ts). Сами данные живут в Y.Doc; здесь
// только отображение и события UI.
import { EditorView, Decoration, type DecorationSet, WidgetType } from '@codemirror/view'
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state'
import type { ThreadView } from './comments'

/** Эффект — заменить набор подсветок (пересчитывается снаружи из Y.Doc). */
export const setCommentRanges = StateEffect.define<ThreadView[]>()

/** Колбэки наружу: клик по подсветке и действия над выделением. */
export interface CommentCallbacks {
  onOpenThread: (threadId: string) => void
  onSelectionComment: (from: number, to: number) => void
  onSelectionSuggest: (from: number, to: number) => void
}

const highlightMark = Decoration.mark({ class: 'cm-comment-mark' })
const highlightResolved = Decoration.mark({ class: 'cm-comment-mark resolved' })

const commentField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setCommentRanges)) {
        const builder = new RangeSetBuilder<Decoration>()
        for (const t of [...e.value].sort((a, b) => a.from - b.from)) {
          if (t.from >= t.to) continue
          builder.add(t.from, t.to, t.resolved ? highlightResolved : highlightMark)
        }
        deco = builder.finish()
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

/** Плавающие кнопки «Комментировать» и «Предложить» над непустым выделением. */
class SelectionActionsWidget extends WidgetType {
  constructor(
    private onComment: () => void,
    private onSuggest: () => void
  ) {
    super()
  }
  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = 'cm-selection-actions'
    const comment = document.createElement('button')
    comment.className = 'cm-comment-add-btn'
    comment.textContent = '💬 Комментировать'
    comment.onmousedown = (e) => {
      e.preventDefault()
      this.onComment()
    }
    const suggest = document.createElement('button')
    suggest.className = 'cm-suggest-add-btn'
    suggest.textContent = '✏️ Предложить'
    suggest.onmousedown = (e) => {
      e.preventDefault()
      this.onSuggest()
    }
    box.append(comment, suggest)
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

export function commentsExtension(cb: CommentCallbacks, canWrite = true) {
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      const el = (event.target as HTMLElement).closest('.cm-comment-mark')
      if (!el) return false
      const pos = view.posAtDOM(el)
      // Находим тред, покрывающий позицию клика.
      const ranges = view.state.field(rangesSnapshot, false) ?? []
      const hit = ranges.find((r) => pos >= r.from && pos <= r.to)
      if (hit) {
        cb.onOpenThread(hit.id)
        return true
      }
      return false
    }
  })

  // Плавающая кнопка над выделением.
  const selectionButton = StateField.define<DecorationSet>({
    create() {
      return Decoration.none
    },
    update(deco, tr) {
      const sel = tr.state.selection.main
      if (sel.empty) return Decoration.none
      const widget = Decoration.widget({
        widget: new SelectionActionsWidget(
          () => cb.onSelectionComment(sel.from, sel.to),
          () => cb.onSelectionSuggest(sel.from, sel.to)
        ),
        side: 1
      })
      return Decoration.set([widget.range(sel.to)])
    },
    provide: (f) => EditorView.decorations.from(f)
  })

  // Read-only: подсветка и открытие тредов работают, кнопок действий нет.
  return canWrite
    ? [commentField, rangesSnapshot, selectionButton, clickHandler]
    : [commentField, rangesSnapshot, clickHandler]
}

/** Держит последний снимок диапазонов, чтобы обработчик клика знал threadId. */
const rangesSnapshot = StateField.define<ThreadView[]>({
  create() {
    return []
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCommentRanges)) return e.value
    return value
  }
})
