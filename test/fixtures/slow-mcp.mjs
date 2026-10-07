/** Minimal real stdio MCP for cancellation/late-reply regressions. No external services. */
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const timers = new Set()
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.id === undefined) return
  if (req.method === 'initialize') reply(req.id, { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'slow-test', version: '1' } })
  else if (req.method === 'tools/list') reply(req.id, { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' }, delayMs: { type: 'number' } } } }] })
  else if (req.method === 'tools/call') {
    const args = req.params.arguments ?? {}
    if (args.delayMs && process.env.MCP_TEST_STARTED) writeFileSync(process.env.MCP_TEST_STARTED, 'started')
    const result = { content: [{ type: 'text', text: String(args.msg ?? '') + ':' + String(process.env.MCP_TEST_GENERATION ?? 'old') }] }
    const timer = setTimeout(() => { timers.delete(timer); reply(req.id, result) }, args.delayMs ?? 0)
    timers.add(timer)
  }
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unknown method' } }) + '\n')
})
input.on('close', () => { for (const timer of timers) clearTimeout(timer) })
