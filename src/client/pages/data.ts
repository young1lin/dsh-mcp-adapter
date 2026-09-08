/**
 * The Data view: browse what the engine's in-process drivers are connected
 * to. One pane per dialect, because these three are not the same shape:
 *  - sql (mysql/pg): tables -> a sorted, filtered row page, plus the
 *    Structure tabs (columns / indexes / foreign keys / DDL), a read-only SQL
 *    console and a capped CSV/JSON export;
 *  - redis: SCAN-paged keys with a pattern + type filter, a type-aware read
 *    of one key, and the read-only command console;
 *  - mongo: collections -> a filtered document grid.
 *
 * These all existed in the ENGINE (data.operation answers thirteen ops) and
 * were simply unreachable: the bridge forwarded three of them, so redis and
 * mongo connections were listed by the picker and then failed on every click.
 * The WRITE ops (row edits, DDL, CSV import) are deliberately still not wired
 * — they need a confirmation flow of their own, not a button.
 *
 * Typed against the bridge contract; when a bridge route is missing the view
 * says so explicitly instead of pretending to load forever.
 */
import type { ReactLike, Kit } from '../ui.js'
import { view } from '../ui.js'
import {
  api, isNoRoute,
  type DataConnection, type DataGridPage, type DataStructure, type DataTablesPage,
  type MongoDocsPage, type RedisKeysPage,
} from '../api.js'

type T = (key: string) => string

const PAGE_LIMIT = 50

/** Every pane reports a missing route as such, never as a hang. */
const problem = (kit: Kit, t: T, err: string) => kit.error(isNoRoute({ message: err }) ? t('bridgePending') : err)
const msg = (error: unknown) => (error as { message?: string }).message ?? String(error)

export function makeDataPage(React: ReactLike, kit: Kit): (props: { t: T }) => unknown {
  type PaneProps = { t: T; conn: DataConnection; onPick: (name: string) => void; onBack: () => void }
  type LeafProps = { t: T; conn: DataConnection; table: string; onBack: () => void }
  const TablesView = view<PaneProps>(React, (p) => TablesPane(React, kit, p.t, p.conn, p.onPick, p.onBack))
  const GridView = view<LeafProps>(React, (p) => GridPane(React, kit, p.t, p.conn, p.table, p.onBack))
  const KeysView = view<{ t: T; conn: DataConnection; onBack: () => void }>(React, (p) => KeysPane(React, kit, p.t, p.conn, p.onBack))
  const CollectionsView = view<PaneProps>(React, (p) => CollectionsPane(React, kit, p.t, p.conn, p.onPick, p.onBack))
  const DocsView = view<LeafProps>(React, (p) => DocsPane(React, kit, p.t, p.conn, p.table, p.onBack))

  return function DataPage(props: { t: T }) {
    const t = props.t
    const [conns, setConns] = React.useState<DataConnection[] | undefined>(undefined)
    const [err, setErr] = React.useState('')
    const [open, setOpen] = React.useState<DataConnection | undefined>(undefined)
    const [table, setTable] = React.useState<string | undefined>(undefined)
    const refresh = React.useCallback(async () => {
      setErr(''); setConns(undefined)
      try { setConns((await api.dataConnections()).connections) } catch (error) { setErr(msg(error)) }
    }, [])
    React.useEffect(() => { void refresh() }, [refresh])
    if (conns === undefined && err === '') return kit.note('…')
    if (err !== '' && conns === undefined) {
      return kit.card(problem(kit, t, err), kit.btn(t('retry'), () => { void refresh() }))
    }
    const back = () => { setOpen(undefined); setTable(undefined) }
    /** One pane per dialect — the three browsers answer different questions. */
    const pane = (conn: DataConnection) => {
      if (conn.dialect === 'redis') return kit.h(KeysView, { key: 'keys', t, conn, onBack: back })
      if (conn.dialect === 'mongo') {
        return table !== undefined
          ? kit.h(DocsView, { key: 'docs', t, conn, table, onBack: () => setTable(undefined) })
          : kit.h(CollectionsView, { key: 'collections', t, conn, onPick: (name: string) => setTable(name), onBack: back })
      }
      return table !== undefined
        ? kit.h(GridView, { key: 'grid', t, conn, table, onBack: () => setTable(undefined) })
        : kit.h(TablesView, { key: 'tables', t, conn, onPick: (name: string) => setTable(name), onBack: back })
    }
    return kit.h('div', { className: 'mmc-root' },
      kit.head(t('dataIntro'), kit.btn(t('refresh'), () => { void refresh() }, { key: 'refresh' })),
      err !== '' ? problem(kit, t, err) : null,
      open !== undefined
        ? pane(open)
        : (conns ?? []).length === 0
        ? kit.empty(t('noDataConnections'))
        // The row itself opens the connection, so the "Browse" button that
        // used to sit at its right edge said the same thing twice.
        : kit.rows(...(conns ?? []).map((c) => kit.row({
            key: c.name,
            state: c.state === 'started' ? 'ok' : c.state === 'error' ? 'bad' : 'off',
            icon: c.dialect,
            name: c.name,
            meta: kit.factsOf(c.label, c.readonly ? t('readonlyTag') : '', c.state !== 'started' ? c.state : ''),
            onOpen: () => { setTable(undefined); setOpen(c) },
          }))),
    )
  }
}

/** The header every pane shares: back, who we are looking at, dialect. */
function paneHead(kit: Kit, conn: DataConnection, onBack: () => void, ...rest: unknown[]) {
  return kit.back(conn.name, onBack, { icon: conn.dialect }, ...rest)
}

// ------------------------------------------------------------------ sql: tables

function TablesPane(React: ReactLike, kit: Kit, t: T, conn: DataConnection, onPick: (name: string) => void, onBack: () => void) {
  const [grep, setGrep] = React.useState('')
  const [page, setPage] = React.useState(0)
  const [data, setData] = React.useState<DataTablesPage | undefined>(undefined)
  const [err, setErr] = React.useState('')
  React.useEffect(() => {
    setErr(''); setData(undefined)
    void api.dataTables(conn.name, grep, page).then(setData).catch((error: unknown) => setErr(msg(error)))
  }, [conn.name, grep, page])
  return kit.card(
    paneHead(kit, conn, onBack,
      kit.input({ placeholder: t('filterTables'), value: grep, onChange: (e: { target: { value: string } }) => { setGrep(e.target.value); setPage(0) }, spellCheck: false })),
    err !== '' ? problem(kit, t, err) : null,
    data === undefined && err === '' ? kit.note('…') : null,
    data !== undefined && data.tables.length === 0 ? kit.empty(t('empty')) : null,
    data !== undefined && data.tables.length > 0
      ? kit.h('div', { className: 'mmc-section' },
        kit.rows(...data.tables.map((tbl) => kit.row({
          key: tbl.name,
          name: tbl.name,
          meta: tbl.rows !== undefined ? t('rowsN').replace('{n}', String(tbl.rows)) : '',
          onOpen: () => onPick(tbl.name),
        }))),
        kit.h('div', { className: 'mmc-row' },
          kit.btn('←', () => { setPage(Math.max(0, page - 1)) }, { key: 'prev', disabled: page === 0, title: t('prevPage') }),
          kit.tag('p' + String(page + 1)),
          kit.btn('→', () => { setPage(page + 1) }, { key: 'next', disabled: data.tables.length === 0, title: t('nextPage') }),
        ),
      )
      : null,
  )
}

// ------------------------------------------------------------------ sql: rows / structure / sql

function GridPane(React: ReactLike, kit: Kit, t: T, conn: DataConnection, tableName: string, onBack: () => void) {
  const [tab, setTab] = React.useState<'rows' | 'structure' | 'sql'>('rows')
  const [offset, setOffset] = React.useState(0)
  const [sort, setSort] = React.useState<{ order: string; dir: 'asc' | 'desc' } | undefined>(undefined)
  const [data, setData] = React.useState<DataGridPage | undefined>(undefined)
  const [structure, setStructure] = React.useState<DataStructure | undefined>(undefined)
  const [err, setErr] = React.useState('')
  const [sql, setSql] = React.useState('')
  const [sqlOut, setSqlOut] = React.useState('')
  const [dump, setDump] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    setErr(''); setData(undefined)
    void api.dataRead(conn.name, tableName, offset, PAGE_LIMIT, sort).then(setData).catch((error: unknown) => setErr(msg(error)))
  }, [conn.name, tableName, offset, sort])
  React.useEffect(() => {
    if (tab !== 'structure' || structure !== undefined) return
    void api.dataStructure(conn.name, tableName).then(setStructure).catch((error: unknown) => setErr(msg(error)))
  }, [tab])
  /** Click a column to sort by it; click again to flip. */
  const sortBy = (column: string) => {
    setOffset(0)
    setSort(sort !== undefined && sort.order === column && sort.dir === 'asc' ? { order: column, dir: 'desc' } : { order: column, dir: 'asc' })
  }
  const runSql = async () => {
    setBusy(true); setSqlOut('')
    try {
      const out = await api.dataQuery(conn.name, sql)
      setSqlOut(JSON.stringify(out.rows.slice(0, 20), null, 2) + (out.truncated === true ? '\n…' : ''))
    } catch (error) { setSqlOut(msg(error)) } finally { setBusy(false) }
  }
  /**
   * Export lands in the panel, not on disk: the settings pane runs inside a
   * sandbox that makes a script-started download inert, so offering a Save
   * button would be a button that does nothing.
   */
  const doExport = async (format: 'csv' | 'json') => {
    setBusy(true); setDump(t('exporting'))
    try {
      const out = await api.dataExport(conn.name, tableName, format)
      setDump(t('exportedN').replace('{n}', String(out.rows)) + (out.capped ? ' · ' + t('exportCapped') : '') + '\n\n' + out.body)
    } catch (error) { setDump(msg(error)) } finally { setBusy(false) }
  }
  return kit.card(
    paneHead(kit, conn, onBack,
      kit.h('span', { className: 'mmc-meta' }, tableName + (data !== undefined ? ' · ' + t('rowsN').replace('{n}', String(data.total)) : '')),
      kit.actions(
        kit.btn('⇤', () => { setOffset(Math.max(0, offset - PAGE_LIMIT)) }, { key: 'prev', disabled: offset === 0, title: t('prevPage') }),
        kit.btn('⇥', () => { setOffset(offset + PAGE_LIMIT) }, { key: 'next', disabled: data !== undefined && offset + PAGE_LIMIT >= data.total, title: t('nextPage') }),
      )),
    kit.tabs([
      { key: 'rows', label: t('rowsTab') }, { key: 'structure', label: t('structure') }, { key: 'sql', label: t('sqlTab') },
    ], tab, (k) => setTab(k as typeof tab)),
    err !== '' ? problem(kit, t, err) : null,
    tab === 'rows' && data === undefined && err === '' ? kit.note('…') : null,
    tab === 'rows' && data !== undefined
      ? kit.h('div', {},
        kit.h('div', { className: 'mmc-scroll' },
          kit.h('table', { className: 'mmc-table' },
            kit.h('thead', {}, kit.h('tr', {}, data.columns.map((c) =>
              kit.h('th', {
                key: c.name, title: c.type ?? c.name, onClick: () => sortBy(c.name),
                ...(sort !== undefined && sort.order === c.name ? { 'data-sorted': 'true' } : {}),
              }, c.name + (sort !== undefined && sort.order === c.name ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''))))),
            kit.h('tbody', {}, data.rows.map((row, i) =>
              kit.h('tr', { key: i }, data.columns.map((c) => {
                const value = row[c.name]
                return kit.h('td', { key: c.name, title: String(value ?? 'NULL'), ...(value === null || value === undefined ? { 'data-null': 'true' } : {}) },
                  value === null || value === undefined ? 'NULL' : String(value))
              })))),
          )),
        kit.h('div', { className: 'mmc-row' },
          kit.h('span', { className: 'mmc-note' }, String(offset) + '–' + String(offset + data.rows.length) + ' / ' + String(data.total) + ' · ' + t('sortHint')),
          kit.actions(
            kit.btn(t('exportCsv'), () => { void doExport('csv') }, { key: 'csv', disabled: busy }),
            kit.btn(t('exportJson'), () => { void doExport('json') }, { key: 'json', disabled: busy }),
          )),
        dump !== '' ? kit.mono(dump) : null,
      )
      : null,
    tab === 'structure' ? StructureBody(kit, t, structure) : null,
    tab === 'sql'
      ? kit.h('div', {},
        kit.textarea({ value: sql, onChange: (e: { target: { value: string } }) => setSql(e.target.value), placeholder: t('sqlPlaceholder'), spellCheck: false }),
        kit.h('div', { className: 'mmc-row' },
          kit.h('span', { className: 'mmc-note' }, t('sqlReadonlyHint')),
          kit.actions(kit.btn(t('runSql'), () => { void runSql() }, { key: 'run', primary: true, disabled: busy || sql.trim().length === 0 }))),
        sqlOut !== '' ? kit.mono(sqlOut) : null,
      )
      : null,
  )
}

/** Columns / indexes / foreign keys / DDL — one card, no extra round trips. */
function StructureBody(kit: Kit, t: T, s: DataStructure | undefined) {
  if (s === undefined) return kit.note('…')
  return kit.h('div', { className: 'mmc-root' },
    kit.h('div', { className: 'mmc-scroll' },
      kit.h('table', { className: 'mmc-table' },
        kit.h('thead', {}, kit.h('tr', {}, [t('name'), t('type'), 'NULL', 'PK', t('defaultValue'), t('comment')].map((h) => kit.h('th', { key: h }, h)))),
        kit.h('tbody', {}, s.columns.map((c) =>
          kit.h('tr', { key: c.name },
            kit.h('td', {}, c.name),
            kit.h('td', {}, c.dataType),
            kit.h('td', {}, c.nullable ? '✓' : ''),
            kit.h('td', {}, c.isPrimaryKey ? '✓' : ''),
            kit.h('td', {}, c.defaultValue ?? ''),
            kit.h('td', { title: c.comment ?? '' }, c.comment ?? ''),
          ))),
      )),
    s.indexes.length > 0
      ? kit.h('div', { className: 'mmc-row' }, kit.h('span', { className: 'mmc-note' }, t('indexes') + ': '),
        s.indexes.map((i) => kit.tag(i.name + ' (' + i.columns.join(', ') + ')', i.primary || i.unique ? 'info' : false, i.name)))
      : null,
    s.foreignKeys.length > 0
      ? kit.h('div', { className: 'mmc-row' }, kit.h('span', { className: 'mmc-note' }, t('foreignKeys') + ': '),
        s.foreignKeys.map((f) => kit.tag(f.columns.join(',') + ' → ' + f.refTable + '(' + f.refColumns.join(',') + ')', false, f.name)))
      : null,
    s.ddl !== '' ? kit.mono(s.ddl) : null,
  )
}

// ------------------------------------------------------------------ redis

const REDIS_TYPES = ['', 'string', 'list', 'set', 'zset', 'hash', 'stream']

function KeysPane(React: ReactLike, kit: Kit, t: T, conn: DataConnection, onBack: () => void) {
  const [pattern, setPattern] = React.useState('')
  const [type, setType] = React.useState('')
  const [cursor, setCursor] = React.useState('')
  const [page, setPage] = React.useState<RedisKeysPage | undefined>(undefined)
  const [err, setErr] = React.useState('')
  const [value, setValue] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [reply, setReply] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    setErr(''); setPage(undefined)
    void api.redisKeys(conn.name, pattern, cursor, type).then(setPage).catch((error: unknown) => setErr(msg(error)))
  }, [conn.name, pattern, type, cursor])
  const openKey = async (key: string) => {
    setValue(t('opening') + ' ' + key)
    try { setValue(key + '\n\n' + JSON.stringify(await api.redisKey(conn.name, key), null, 2)) }
    catch (error) { setValue(key + '\n\n' + msg(error)) }
  }
  const run = async () => {
    setBusy(true); setReply('')
    try { setReply(JSON.stringify((await api.redisCommand(conn.name, command)).reply, null, 2)) }
    catch (error) { setReply(msg(error)) } finally { setBusy(false) }
  }
  return kit.card(
    paneHead(kit, conn, onBack,
      kit.input({ placeholder: t('keyPattern'), value: pattern, onChange: (e: { target: { value: string } }) => { setPattern(e.target.value); setCursor('') }, spellCheck: false }),
      kit.select({ value: type, onChange: (e: { target: { value: string } }) => { setType(e.target.value); setCursor('') }, title: t('keyType') },
        REDIS_TYPES.map((x) => kit.h('option', { key: x === '' ? 'all' : x, value: x }, x === '' ? t('allTypes') : x))),
    ),
    err !== '' ? problem(kit, t, err) : null,
    page === undefined && err === '' ? kit.note('…') : null,
    page !== undefined && page.keys.length === 0 ? kit.empty(t('empty')) : null,
    page !== undefined && page.keys.length > 0
      ? kit.h('div', { className: 'mmc-section' },
        kit.rows(...page.keys.map((k) => kit.row({
          key: k.key,
          name: k.key,
          badge: { text: k.type },
          meta: kit.factsOf(
            k.ttl !== undefined && k.ttl >= 0 ? 'TTL ' + String(k.ttl) + 's' : '',
            k.size !== undefined ? String(k.size) : '',
          ),
          onOpen: () => { void openKey(k.key) },
        }))),
        // SCAN is a cursor, not a page number: there is a "next", never a "back".
        kit.h('div', { className: 'mmc-row' },
          kit.h('span', { className: 'mmc-note' }, page.total !== undefined ? t('keysN').replace('{n}', String(page.total)) : ''),
          kit.actions(
            kit.btn(t('rewind'), () => setCursor(''), { key: 'rewind', disabled: cursor === '' }),
            kit.btn(t('more'), () => setCursor(page.cursor), { key: 'more', disabled: page.done }),
          )),
      )
      : null,
    value !== '' ? kit.mono(value) : null,
    kit.h('div', { className: 'mmc-row' },
      kit.input({ placeholder: t('redisConsole'), value: command, onChange: (e: { target: { value: string } }) => setCommand(e.target.value), spellCheck: false, style: { flex: 1 } }),
      kit.actions(kit.btn(t('runCommand'), () => { void run() }, { key: 'run', primary: true, disabled: busy || command.trim() === '' }))),
    kit.note(t('redisReadonlyHint')),
    reply !== '' ? kit.mono(reply) : null,
  )
}

// ------------------------------------------------------------------ mongo

function CollectionsPane(React: ReactLike, kit: Kit, t: T, conn: DataConnection, onPick: (name: string) => void, onBack: () => void) {
  const [grep, setGrep] = React.useState('')
  const [rows, setRows] = React.useState<Array<{ name: string; type: string; approxDocs: number; size: string }> | undefined>(undefined)
  const [err, setErr] = React.useState('')
  React.useEffect(() => {
    setErr(''); setRows(undefined)
    void api.mongoCollections(conn.name, grep).then((out) => setRows(out.collections)).catch((error: unknown) => setErr(msg(error)))
  }, [conn.name, grep])
  return kit.card(
    paneHead(kit, conn, onBack,
      kit.input({ placeholder: t('filterTables'), value: grep, onChange: (e: { target: { value: string } }) => setGrep(e.target.value), spellCheck: false })),
    err !== '' ? problem(kit, t, err) : null,
    rows === undefined && err === '' ? kit.note('…') : null,
    rows !== undefined && rows.length === 0 ? kit.empty(t('empty')) : null,
    rows !== undefined && rows.length > 0
      ? kit.rows(...rows.map((c) => kit.row({
          key: c.name,
          name: c.name,
          badge: { text: c.type },
          meta: kit.factsOf(t('rowsN').replace('{n}', String(c.approxDocs)), c.size),
          onOpen: () => onPick(c.name),
        })))
      : null,
  )
}

function DocsPane(React: ReactLike, kit: Kit, t: T, conn: DataConnection, collection: string, onBack: () => void) {
  const [filter, setFilter] = React.useState('')
  const [applied, setApplied] = React.useState('')
  const [offset, setOffset] = React.useState(0)
  const [page, setPage] = React.useState<MongoDocsPage | undefined>(undefined)
  const [err, setErr] = React.useState('')
  React.useEffect(() => {
    setErr(''); setPage(undefined)
    void api.mongoDocs(conn.name, collection, applied, offset, PAGE_LIMIT).then(setPage).catch((error: unknown) => setErr(msg(error)))
  }, [conn.name, collection, applied, offset])
  return kit.card(
    paneHead(kit, conn, onBack,
      kit.h('span', { className: 'mmc-meta' }, collection + (page !== undefined ? ' · ' + t('rowsN').replace('{n}', String(page.total)) : '')),
      kit.actions(
        kit.btn('⇤', () => { setOffset(Math.max(0, offset - PAGE_LIMIT)) }, { key: 'prev', disabled: offset === 0, title: t('prevPage') }),
        kit.btn('⇥', () => { setOffset(offset + PAGE_LIMIT) }, { key: 'next', disabled: page !== undefined && offset + PAGE_LIMIT >= page.total, title: t('nextPage') }),
      )),
    kit.h('div', { className: 'mmc-row' },
      kit.input({ placeholder: t('filterJson'), value: filter, onChange: (e: { target: { value: string } }) => setFilter(e.target.value), spellCheck: false, style: { flex: 1 } }),
      kit.actions(kit.btn(t('applyFilter'), () => { setOffset(0); setApplied(filter) }, { key: 'apply' }))),
    err !== '' ? problem(kit, t, err) : null,
    page === undefined && err === '' ? kit.note('…') : null,
    page !== undefined
      ? kit.h('div', { className: 'mmc-scroll' },
        kit.h('table', { className: 'mmc-table' },
          kit.h('thead', {}, kit.h('tr', {}, page.fields.map((f) => kit.h('th', { key: f }, f)))),
          kit.h('tbody', {}, page.documents.map((doc, i) =>
            kit.h('tr', { key: i }, page.fields.map((f) => {
              const value = doc[f]
              const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
              return kit.h('td', { key: f, title: text, ...(value === undefined || value === null ? { 'data-null': 'true' } : {}) }, text)
            })))),
        ))
      : null,
  )
}
