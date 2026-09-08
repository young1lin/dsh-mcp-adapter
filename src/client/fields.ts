/**
 * Typed connection schemas — the form behind "Add an MCP".
 *
 * The engine has always shipped in-process drivers for mysql / pg / redis /
 * mongo plus proc / http / rest / echo (src/engine/adapters/*), the config
 * layer validates them (config/service.ts validateNativeDef) and the Data tab
 * browses them. The only thing missing was a way to CREATE one: the editor
 * was a bare JSON textarea, so every driver was reachable only by knowing its
 * option names by heart. This module is that missing half — the same field
 * set the gateway panel had, typed, bilingual, and round-trippable.
 *
 * Two rules make the form safe to put in front of an existing definition:
 *  - the key names here are the keys the ADAPTERS actually read (verified
 *    against src/engine/adapters/*.ts), never a parallel vocabulary;
 *  - a definition is never rebuilt from the form alone. formToDef starts from
 *    the original object, so a key this schema does not model survives an
 *    edit instead of being silently dropped (unknownKeys reports them, and
 *    the editor says so rather than pretending the form is the whole truth).
 *
 * `lazy` is exposed as itself, not as an inverted "start automatically"
 * checkbox: the def is what gets stored, and a form that writes a different
 * key than it shows is a bug waiting for its first round trip.
 *
 * @module dsh-mcp-adapter/client/fields
 */

/** One editable field of one connection type. */
export interface FieldSpec {
  k: string
  en: string
  zh: string
  ph?: string
  /** Chinese placeholder, for the few that are prose rather than syntax. */
  phZh?: string
  hintEn?: string
  hintZh?: string
  /** Renders at half width — two per line on a wide enough pane. */
  half?: boolean
  bool?: boolean
  /** Default for a boolean when the definition does not say. */
  def?: boolean
  num?: boolean
  area?: boolean
  /** KEY=VALUE per line <-> Record<string,string>. */
  kv?: boolean
  /** One entry per line <-> string[]. */
  list?: boolean
  /** Free JSON <-> whatever it parses to. */
  json?: boolean
}

const DESCRIPTION: FieldSpec = {
  k: 'description', en: 'Description', zh: '描述',
  ph: 'IM service Redis, used by the chat backend',
  phZh: '聊天后端用的 IM Redis',
  hintEn: 'Sent to clients as this server’s instructions. With several instances of one engine behind identical tools, it is the only thing that says whose data is on the other end.',
  hintZh: '会作为该服务的说明发给客户端。同一种引擎挂多个实例时，工具名完全一样，只有这句话能说明连的是谁的数据。',
}
const LAZY_ON: FieldSpec = {
  k: 'lazy', en: 'Start on first use', zh: '首次调用时再启动', bool: true, def: true,
  hintEn: 'On by default for proc: the child process is the expensive idle thing here, so it spawns on the first request and is reaped when idle.',
  hintZh: 'proc 默认开启：子进程是这里唯一真正占内存的东西，所以首次请求才启动，空闲后回收。',
}
const LAZY_OFF: FieldSpec = {
  k: 'lazy', en: 'Start on first use', zh: '首次调用时再启动', bool: true, def: false,
  hintEn: 'Off by default: connect at boot. On means the first request pays the connection cost.',
  hintZh: '默认关闭：启动时就连接。开启则由第一次请求承担连接开销。',
}
const READONLY = (hintEn: string, hintZh: string): FieldSpec =>
  ({ k: 'readonly', en: 'Read-only', zh: '只读', bool: true, hintEn, hintZh })
const MAX_ROWS: FieldSpec = { k: 'maxRows', en: 'Default row limit', zh: '默认返回行数上限', num: true, half: true, ph: '200' }
const HEADERS: FieldSpec = {
  k: 'headers', en: 'Headers (NAME=VALUE per line)', zh: '请求头（每行 NAME=VALUE）', area: true, kv: true,
  ph: 'Authorization=Bearer ${MY_API_KEY}',
  hintEn: 'Where the remote’s API key goes. Prefer a ${ENV_VAR} reference: the key then lives in .env and never in this panel or the stored definition.',
  hintZh: 'API key 放这里。优先写 ${环境变量} 引用——这样密钥只存在于 .env，面板和配置文件里都不会留下明文。',
}
const PROXY: FieldSpec = {
  k: 'proxy', en: 'Proxy', zh: '代理', ph: 'http://127.0.0.1:7890 or ${MY_PROXY}',
  hintEn: 'Routes THIS server’s requests through an HTTP(S) proxy, for an endpoint this machine cannot reach directly. Other servers are unaffected.',
  hintZh: '只让这一个服务走 HTTP(S) 代理，用于本机直连不到的地址。不影响其他服务。',
}
const EXPOSE_RESOURCES: FieldSpec = {
  k: 'exposeResources', en: 'Expose resources', zh: '暴露 resources', bool: true, def: true,
  hintEn: 'Turn off for a server that publishes thousands of resources.', hintZh: '对方 resources 成千上万时关掉。',
}
const EXPOSE_PROMPTS: FieldSpec = { k: 'exposePrompts', en: 'Expose prompts', zh: '暴露 prompts', bool: true, def: true }

/**
 * The two STANDARD shapes (.mcp.json). They deliberately carry no `type`
 * key: that file is an interop surface shared with other MCP clients, and a
 * dsh-only discriminator in it is pollution. The shape IS the type —
 * `command` means stdio, `url` means remote (standard-repo.validateEntry
 * refuses both at once).
 */
const STANDARD: Record<string, FieldSpec[]> = {
  stdio: [
    { k: 'command', en: 'Command', zh: '命令', ph: 'npx' },
    { k: 'args', en: 'Arguments (one per line)', zh: '参数（每行一个）', area: true, list: true, ph: '-y\n@modelcontextprotocol/server-git' },
    { k: 'env', en: 'Environment (KEY=VALUE per line)', zh: '环境变量（每行 KEY=VALUE）', area: true, kv: true, ph: 'GIT_REPO=D:\\dev\\project' },
    { k: 'cwd', en: 'Working directory', zh: '工作目录', ph: 'optional' },
  ],
  remote: [
    { k: 'url', en: 'Endpoint URL', zh: '服务地址', ph: 'https://mcp.context7.com/mcp' },
    HEADERS,
  ],
}

/** The NATIVE shapes (engine ServerDef dialect; keys read by the adapters). */
const NATIVE: Record<string, FieldSpec[]> = {
  proc: [
    DESCRIPTION,
    { k: 'command', en: 'Command', zh: '命令', ph: 'npx -y @modelcontextprotocol/server-git   ·   uvx mcp-server-git' },
    { k: 'cwd', en: 'Working directory', zh: '工作目录', ph: 'optional' },
    { k: 'env', en: 'Environment (KEY=VALUE per line)', zh: '环境变量（每行 KEY=VALUE）', area: true, kv: true, ph: 'GIT_REPO=D:\\dev\\project' },
    EXPOSE_RESOURCES, EXPOSE_PROMPTS,
    {
      k: 'timeoutMs', en: 'Call timeout (ms)', zh: '调用超时（毫秒）', num: true, half: true, ph: '180000',
      hintEn: 'How long one tool call may run. Raise it for slow work — image analysis and long scrapes routinely pass a minute.',
      hintZh: '单次工具调用的时限。慢活儿要调大——图像分析、长爬取动辄超过一分钟。',
    },
    LAZY_ON,
  ],
  mysql: [
    DESCRIPTION,
    { k: 'host', en: 'Host', zh: '主机', half: true, ph: '127.0.0.1' },
    { k: 'port', en: 'Port', zh: '端口', num: true, half: true, ph: '3306' },
    { k: 'user', en: 'User', zh: '用户', half: true, ph: 'root' },
    { k: 'password', en: 'Password', zh: '密码', half: true, ph: '${MYSQL_PASSWORD}' },
    { k: 'database', en: 'Database', zh: '数据库', half: true },
    { k: 'timezone', en: 'Timezone', zh: '时区', half: true, ph: 'Z' },
    MAX_ROWS,
    READONLY('Refuses writes, and sets the session read-only server-side.', '拒绝写入，同时在服务端把会话设为只读。'),
    LAZY_OFF,
  ],
  pg: [
    DESCRIPTION,
    { k: 'url', en: 'Connection URL', zh: '连接串', area: true, ph: 'postgresql://user:pass@127.0.0.1:5432/db?sslmode=disable' },
    MAX_ROWS,
    READONLY('Sets default_transaction_read_only on the session.', '在会话上设置 default_transaction_read_only。'),
    LAZY_OFF,
  ],
  redis: [
    DESCRIPTION,
    { k: 'host', en: 'Host', zh: '主机', half: true, ph: '127.0.0.1' },
    { k: 'port', en: 'Port', zh: '端口', num: true, half: true, ph: '6379' },
    { k: 'password', en: 'Password', zh: '密码', half: true, ph: '${REDIS_PASSWORD}' },
    { k: 'db', en: 'DB index', zh: '库序号', num: true, half: true, ph: '0' },
    READONLY('Only read commands are accepted.', '只接受读命令。'),
    { k: 'allowDestructive', en: 'Allow FLUSHALL / FLUSHDB', zh: '允许 FLUSHALL / FLUSHDB', bool: true },
    {
      k: 'allowEval', en: 'Allow Lua (EVAL / FCALL)', zh: '允许 Lua（EVAL / FCALL）', bool: true,
      hintEn: 'A script is opaque to every other rule here — it can reach anything they refuse.',
      hintZh: '脚本对上面所有规则都是黑盒——它能做到那些规则明确拒绝的事。',
    },
    LAZY_OFF,
  ],
  mongo: [
    DESCRIPTION,
    { k: 'url', en: 'Connection URL', zh: '连接串', area: true, ph: 'mongodb://user:pass@127.0.0.1:27017/db?authSource=admin' },
    { k: 'database', en: 'Database (override)', zh: '数据库（覆盖）', half: true, ph: 'defaults to the URL path' },
    MAX_ROWS,
    READONLY('Hides the write tools and refuses $out / $merge.', '隐藏写工具，并拒绝 $out / $merge。'),
    LAZY_OFF,
  ],
  http: [
    DESCRIPTION,
    { k: 'url', en: 'Endpoint URL', zh: '服务地址', area: true, ph: 'https://mcp.context7.com/mcp' },
    HEADERS, PROXY, EXPOSE_RESOURCES, EXPOSE_PROMPTS, LAZY_OFF,
  ],
  rest: [
    DESCRIPTION,
    { k: 'baseUrl', en: 'Base URL', zh: '基地址', ph: 'https://api.github.com' },
    HEADERS, PROXY,
    {
      k: 'tools', en: 'Tool declarations (JSON)', zh: '工具声明（JSON）', area: true, json: true,
      ph: '[{"name":"get_repo","description":"Get a public GitHub repo.","input":{"owner":{"type":"string","required":true},"repo":{"type":"string","required":true}},"request":{"method":"GET","path":"/repos/{{owner}}/{{repo}}"},"pick":["full_name","description","stargazers_count"]}]',
      hintEn: 'Paste the vendor’s own example with {{arg}} in the slots the model should fill. Note {{arg}} is a tool argument — ${VAR} is an environment variable.',
      hintZh: '把厂商文档里的示例贴进来，需要模型填的位置写 {{参数名}}。注意 {{参数}} 是工具入参，${变量} 是环境变量。',
    },
    { k: 'timeoutMs', en: 'Timeout (ms)', zh: '超时（毫秒）', num: true, half: true, ph: '30000' },
    LAZY_OFF,
  ],
  echo: [DESCRIPTION],
}

/** Human labels for the type picker. */
const LABELS: Record<string, { en: string; zh: string }> = {
  stdio: { en: 'stdio — run a command locally', zh: 'stdio — 本地启动一个命令' },
  remote: { en: 'remote — an MCP server over http/sse', zh: 'remote — 远端 http/sse 的 MCP 服务' },
  proc: { en: 'proc — spawn a command and proxy it', zh: 'proc — 启动命令并代理它' },
  mysql: { en: 'mysql — in-process driver', zh: 'mysql — 内置驱动直连' },
  pg: { en: 'postgres — in-process driver', zh: 'postgres — 内置驱动直连' },
  redis: { en: 'redis — in-process driver', zh: 'redis — 内置驱动直连' },
  mongo: { en: 'mongo — in-process driver', zh: 'mongo — 内置驱动直连' },
  http: { en: 'http — proxy a remote MCP endpoint', zh: 'http — 代理远端 MCP 端点' },
  rest: { en: 'rest — declare tools over a plain HTTP API', zh: 'rest — 在普通 HTTP API 上声明工具' },
  echo: { en: 'echo — a built-in probe, for checking wiring', zh: 'echo — 内置探针，用来验证链路' },
}

/** Types a layer can hold. Native layers get the drivers; standard files cannot. */
export function typesFor(layerId: string | undefined): string[] {
  return layerId === 'global:native' || layerId === 'project:native'
    ? ['proc', 'mysql', 'pg', 'redis', 'mongo', 'http', 'rest', 'echo']
    : ['stdio', 'remote']
}

export function fieldsFor(type: string): FieldSpec[] {
  return NATIVE[type] ?? STANDARD[type] ?? []
}

export function labelFor(type: string, lang: string): string {
  const label = LABELS[type]
  return label === undefined ? type : lang === 'zh' ? label.zh : label.en
}

/** What type is this definition already? Shape decides for standard entries. */
export function typeOfDef(def: Record<string, unknown>, layerId: string | undefined): string {
  if (typeof def.type === 'string' && def.type !== '') return def.type
  if (typesFor(layerId)[0] === 'stdio') return typeof def.url === 'string' ? 'remote' : 'stdio'
  return typeof def.url === 'string' ? 'http' : 'proc'
}

/** Keys of a definition this schema does not model — surfaced, never dropped. */
export function unknownKeys(def: Record<string, unknown>, type: string): string[] {
  const known = new Set(fieldsFor(type).map((f) => f.k))
  known.add('type'); known.add('disabled')
  return Object.keys(def).filter((k) => !known.has(k))
}

// --- value <-> text -----------------------------------------------------------------------------

function kvToText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => k + '=' + String(v)).join('\n')
}
function textToKv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** One field's current value as the text/checkbox the form shows. */
export function fieldValue(def: Record<string, unknown>, field: FieldSpec): string | boolean {
  const raw = def[field.k]
  if (field.bool === true) return typeof raw === 'boolean' ? raw : field.def === true
  if (raw === undefined || raw === null) return ''
  if (field.kv === true) return kvToText(raw)
  if (field.list === true) return Array.isArray(raw) ? raw.map((x) => String(x)).join('\n') : String(raw)
  if (field.json === true) return JSON.stringify(raw, null, 2)
  return String(raw)
}

/**
 * Fold one edited field back into the definition. The ORIGINAL object is the
 * base, so keys outside this schema ride through untouched; clearing a field
 * removes its key rather than storing an empty string, and a boolean equal to
 * its default is likewise left out so the stored file stays minimal.
 * A `json` field that does not parse throws — the caller shows the message
 * instead of writing half a definition.
 */
export function applyField(def: Record<string, unknown>, field: FieldSpec, value: string | boolean): Record<string, unknown> {
  const next = { ...def }
  if (field.bool === true) {
    if (value === (field.def === true)) delete next[field.k]
    else next[field.k] = value === true
    return next
  }
  const text = String(value)
  if (text.trim() === '') { delete next[field.k]; return next }
  if (field.num === true) {
    const n = Number(text)
    if (!Number.isFinite(n)) throw new Error(field.k + ': not a number')
    next[field.k] = n
  } else if (field.kv === true) next[field.k] = textToKv(text)
  else if (field.list === true) next[field.k] = text.split('\n').map((x) => x.trim()).filter((x) => x !== '')
  else if (field.json === true) next[field.k] = JSON.parse(text)
  else next[field.k] = text
  return next
}

/**
 * Switch a definition to another type, keeping the values both types share.
 * Standard shapes carry no `type` key (see STANDARD above) and are mutually
 * exclusive, so switching drops the other shape's discriminating key.
 */
export function retype(def: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const keep = new Set(fieldsFor(to).map((f) => f.k))
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(def)) {
    if (k === 'type') continue
    if (keep.has(k) || !new Set(fieldsFor(from).map((f) => f.k)).has(k)) next[k] = v
  }
  if (NATIVE[to] !== undefined) next.type = to
  if (to === 'stdio') delete next.url
  if (to === 'remote') { delete next.command; delete next.args; delete next.cwd }
  return next
}

/** A blank definition of one type — every default made explicit by omission. */
export function blankDef(type: string): Record<string, unknown> {
  return NATIVE[type] !== undefined ? { type } : {}
}
