/**
 * Put an MCP mark on this plugin's row in the settings nav.
 *
 * The settings shell chooses that icon from a HARD-CODED id list — `navIcon`
 * in @deepseek-ai/dsh-client-ui-settings-general answers models →
 * IconDataOutline16, agent-presets → IconAgentPresetOutline16, plugins →
 * IconPersonalizationOutline16, and everything else → IconSettingsOutline16,
 * the gear it uses to mean "a settings page". The slot contract carries `id`,
 * `order` and `label` and nothing else (SettingsSectionOwnerProps), so a
 * registrant has no icon to register: the only way to show an MCP mark is to
 * replace the glyph the shell already drew.
 *
 * So this is deliberately timid. It touches exactly one node — the <svg>
 * inside the nav button whose text is OUR label — keeps the original to put
 * back on dispose, and re-runs when the panel is rebuilt. If the shell's
 * markup changes, nothing matches and the gear simply stays: a wrong icon is
 * the whole cost of being wrong here.
 *
 * No relative runtime imports: the tests load this module as source.
 *
 * @module dsh-mcp-adapter/client/nav-icon
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Marks a cell we have already painted, so a repaint is not a repaint loop. */
const PAINTED = 'data-mmc-nav-icon'

/**
 * The MCP mark: the official Model Context Protocol logo, taken from the
 * brand's own asset (simple-icons `modelcontextprotocol`, a 24x24 monochrome
 * glyph) rather than redrawn by hand — a hand-approximated logo is a wrong
 * logo, and this one's three interlocking hooks are exactly what makes it
 * recognisable at a glance.
 *
 * It is a FILLED outline of a stroked design, not a stroke: painting it with
 * `stroke` would trace every edge and double the whole mark. At 16px its
 * limbs land near 1.1px, the weight the shell's own outline glyphs carry.
 */
export const MCP_MARK = {
  viewBox: '0 0 24 24',
  paths: [
    'M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245',
  ],
}

/** The DOM surface this needs — small enough that a test can supply it. */
export interface NavDoc {
  querySelectorAll: (selector: string) => ArrayLike<NavCell>
  createElementNS: (ns: string, tag: string) => NavNode
}
export interface NavNode {
  setAttribute: (name: string, value: string) => void
  appendChild: (child: NavNode) => unknown
  replaceWith: (node: NavNode) => void
  getAttribute?: (name: string) => string | null
}
export interface NavCell {
  textContent: string | null
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  querySelector: (selector: string) => NavNode | null
}

/** Build the mark, carrying over the class the shell had put on its own icon. */
function buildMark(doc: NavDoc, className: string | null): NavNode {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  if (className !== null && className !== '') svg.setAttribute('class', className)
  svg.setAttribute('viewBox', MCP_MARK.viewBox)
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  // currentColor, so the mark tracks the row's selected/hover colour exactly
  // as the glyph it replaced did.
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const d of MCP_MARK.paths) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

/**
 * Paint the mark now, and keep it painted. Returns the disposer: it stops
 * watching and puts every gear it replaced back.
 */
export function paintNavIcon(label: () => string, doc?: NavDoc): () => void {
  const target = doc ?? (typeof document === 'undefined' ? undefined : (document as unknown as NavDoc))
  if (target === undefined) return () => { /* no DOM: nothing to paint */ }
  const undo: Array<() => void> = []
  const paint = (): void => {
    const want = label().trim()
    if (want === '') return
    const cells = target.querySelectorAll('[role="dialog"] nav button')
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i]
      if (cell === undefined || cell.getAttribute(PAINTED) !== null) continue
      if ((cell.textContent ?? '').trim() !== want) continue
      const gear = cell.querySelector('svg')
      if (gear === null) continue
      const mark = buildMark(target, gear.getAttribute?.('class') ?? null)
      gear.replaceWith(mark)
      cell.setAttribute(PAINTED, '1')
      undo.push(() => { mark.replaceWith(gear); cell.removeAttribute(PAINTED) })
    }
  }
  paint()
  // The panel is mounted and unmounted with the dialog, and the nav is rebuilt
  // whenever the section list or the locale changes, so one pass is not enough.
  // Painting sets an attribute, which is itself a mutation — the PAINTED guard
  // is what makes the next pass a no-op and stops the loop.
  let observer: MutationObserver | undefined
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && doc === undefined) {
    observer = new MutationObserver(() => paint())
    observer.observe(document.body, { childList: true, subtree: true })
  }
  return () => {
    observer?.disconnect()
    for (const back of undo.splice(0)) back()
  }
}
