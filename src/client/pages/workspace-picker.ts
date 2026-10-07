/** Searchable workspace listbox; only IDs cross the bridge, never display paths. */
import type { ReactLike, Kit } from '../ui.js'
import { view } from '../ui.js'
import type { WorkspaceItem } from '../api.js'

/** Optional shell baseline components. Older hosts can safely use the local surface. */
export interface WorkspacePickerHost {
  MenuSurface?: unknown
  Input?: unknown
  createPortal?: (node: unknown, container: Element) => unknown
}
type Props = { t: (key: string) => string; value: string; items: WorkspaceItem[]; onChange: (id: string) => void }
interface Position { left: number; width: number; maxHeight: number; top?: number; bottom?: number }
let serial = 0

export function workspaceLabel(item: WorkspaceItem): string {
  if (item.title?.trim()) return item.title.trim()
  const parts = item.path.replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? item.id.slice(0, 8)
}

export function makeWorkspacePicker(React: ReactLike, kit: Kit, host: WorkspacePickerHost = {}) {
  return view<Props>(React, ({ t, value, items, onChange }) => {
    const [at, setAt] = React.useState<Position | undefined>(undefined)
    const [query, setQuery] = React.useState('')
    const [active, setActive] = React.useState(0)
    const [id] = React.useState(() => 'mcp-workspaces-' + String(++serial))
    const [refs] = React.useState(() => ({ trigger: null as HTMLButtonElement | null, popup: null as HTMLDivElement | null, input: null as HTMLInputElement | null, open: false }))
    refs.open = at !== undefined
    const selected = items.find((item) => item.id === value)
    const label = value === '' ? t('scopeGlobal') : selected !== undefined ? workspaceLabel(selected) : value.slice(0, 8)
    const options = [{ id: '', label: t('scopeGlobal'), path: t('workspaceGlobalHint') }, ...items.map((item) => ({ id: item.id, label: workspaceLabel(item), path: item.path }))]
    const needle = query.trim().toLocaleLowerCase()
    const filtered = options.filter((option) => (option.label + ' ' + option.path + ' ' + option.id).toLocaleLowerCase().includes(needle))
    const index = Math.min(active, Math.max(0, filtered.length - 1))
    const close = (restoreFocus = false) => { setAt(undefined); if (restoreFocus) refs.trigger?.focus() }
    const pick = (id: string) => { close(true); onChange(id) }
    const open = (event?: unknown) => {
      const el = (event as { currentTarget?: HTMLButtonElement } | undefined)?.currentTarget ?? refs.trigger
      const rect = el?.getBoundingClientRect?.()
      const vw = typeof window === 'undefined' ? 1024 : window.innerWidth ?? 1024
      const vh = typeof window === 'undefined' ? 768 : window.innerHeight ?? 768
      const width = Math.min(Math.max(rect?.width ?? 240, 320), 360, vw - 24)
      const below = vh - (rect?.bottom ?? 0) - 16
      const above = (rect?.top ?? 0) - 16
      const flip = below < 240 && above > below
      setAt({ left: Math.max(12, Math.min(rect?.left ?? 12, vw - width - 12)), width, maxHeight: Math.max(80, Math.min(400, flip ? above : below)), ...(flip ? { bottom: vh - rect!.top + 4 } : { top: (rect?.bottom ?? 0) + 4 }) })
      setQuery('')
      setActive(Math.max(0, options.findIndex((option) => option.id === value)))
    }
    React.useEffect(() => {
      if (typeof document === 'undefined') return
      const inside = (target: EventTarget | null) => target instanceof Node && (refs.trigger?.contains(target) || refs.popup?.contains(target))
      const outside = (event: Event) => { if (refs.open && !inside(event.target)) setAt(undefined) }
      const scroll = (event: Event) => { if (refs.open && !(event.target instanceof Node && refs.popup?.contains(event.target))) setAt(undefined) }
      const resize = () => setAt(undefined)
      document.addEventListener('pointerdown', outside)
      document.addEventListener('focusin', outside)
      window.addEventListener('scroll', scroll, true)
      window.addEventListener('resize', resize)
      return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize) }
    }, [refs])
    // Focus only after BOTH input and popup refs attach. autoFocus runs during
    // commitMount before the parent ref and falsely trips outside dismissal.
    React.useEffect(() => { if (at !== undefined) refs.input?.focus({ preventScroll: true }) }, [at])
    React.useEffect(() => {
      if (at !== undefined && typeof document !== 'undefined') document.getElementById(id + '-' + String(index))?.scrollIntoView?.({ block: 'nearest' })
    }, [at, index, query])
    const onKey = (event: { key: string; keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean }; preventDefault: () => void; stopPropagation?: () => void }) => {
      if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); close(true); return }
      if (event.key === 'Tab') { refs.trigger?.focus({ preventScroll: true }); close(); return }
      if (event.key === 'Enter' && filtered[index] !== undefined) { event.preventDefault(); pick(filtered[index]!.id); return }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        setActive(event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0, filtered.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(1, filtered.length))
      }
    }
    const icon = (kind: 'folder' | 'search' | 'chevron' | 'check') => kit.h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      kit.h('path', { d: kind === 'folder' ? 'M2 4.5h4l1.5 1.5H14v6.5H2z M2 4.5V3h4l1.5 1.5' : kind === 'search' ? 'M11 11l3 3 M11.5 6.5a5 5 0 1 1-10 0a5 5 0 0 1 10 0' : kind === 'chevron' ? 'M4.5 6.5L8 10l3.5-3.5' : 'M3 8l3 3 7-7' }))
    const inputProps = { className: host.Input !== undefined ? 'mmc-ws-search' : 'mmc-ws-search-input', ref: (el: HTMLInputElement | null) => { refs.input = el }, role: 'combobox', 'aria-label': t('workspaceSearch'), 'aria-expanded': 'true', 'aria-controls': id, 'aria-autocomplete': 'list', ...(filtered.length > 0 ? { 'aria-activedescendant': id + '-' + String(index) } : {}), placeholder: t('workspaceSearch'), value: query, spellCheck: false, onKeyDown: onKey, onChange: (e: { target: { value: string } }) => { setQuery(e.target.value); setActive(0) } }
    const popup = at === undefined ? null : kit.h(host.MenuSurface ?? 'div', { className: 'mmc-ws-popup', 'data-host-surface': host.MenuSurface !== undefined ? 'true' : undefined, ref: (el: HTMLDivElement | null) => { refs.popup = el }, style: { left: at.left, width: at.width, maxHeight: at.maxHeight, ...(at.top !== undefined ? { top: at.top } : { bottom: at.bottom }) } },
      host.Input !== undefined ? kit.h(host.Input, { ...inputProps, icon: icon('search') }) : kit.h('span', { className: 'mmc-ws-search' }, icon('search'), kit.h('input', inputProps)),
      kit.h('div', { id, role: 'listbox', 'aria-label': t('workspace'), className: 'mmc-ws-options' },
        filtered.length === 0 ? kit.h('div', { className: 'mmc-ws-empty', role: 'status' }, t('workspaceNoMatches')) : filtered.map((option, i) => kit.h('button', { key: option.id, id: id + '-' + String(i), type: 'button', role: 'option', tabIndex: -1, className: 'mmc-ws-option', 'aria-selected': option.id === value ? 'true' : 'false', 'data-active': i === index ? 'true' : undefined, title: option.path + (option.id !== '' ? ' · ' + option.id : ''), onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(), onMouseMove: () => setActive(i), onClick: () => pick(option.id) },
          icon('folder'), kit.h('span', { className: 'mmc-ws-option-text' }, kit.h('span', { className: 'mmc-ws-option-label' }, option.label), kit.h('span', { className: 'mmc-ws-option-path' }, option.path)), kit.h('span', { className: 'mmc-ws-check' }, option.id === value ? icon('check') : null)))),
    )
    return kit.h('div', { className: 'mmc-ws-picker' },
      kit.h('button', { type: 'button', className: 'mmc-ws-trigger', ref: (el: HTMLButtonElement | null) => { refs.trigger = el }, 'aria-label': t('workspace') + ': ' + label, 'aria-haspopup': 'listbox', 'aria-expanded': at !== undefined ? 'true' : 'false', 'aria-controls': at !== undefined ? id : undefined, title: selected?.path ?? t('scopeGlobal'), onClick: (event: unknown) => at !== undefined ? close() : open(event), onKeyDown: (event: { key: string; preventDefault: () => void; currentTarget?: HTMLButtonElement }) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(event) } } }, icon('folder'), kit.h('span', { className: 'mmc-ws-trigger-label' }, label), icon('chevron')),
      popup !== null && host.createPortal !== undefined && typeof document !== 'undefined' ? host.createPortal(popup, document.body) : popup,
    )
  })
}
