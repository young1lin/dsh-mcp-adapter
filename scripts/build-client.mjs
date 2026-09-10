/**
 * Build the browser half with the module id INJECTED from package.json.
 *
 * The dsh client-modules contract (packages/client/modules, manifest.ts:
 * "Plugin id (package name) — the registration key; must match the graph
 * row being executed") keys the bundle registration on the package name the
 * loader discovered for the row. A hardcoded id drifts the moment the
 * package is renamed — which is exactly how the 0.3.2 scoped rename broke
 * the settings panel while the host half kept working. Deriving the id
 * here makes the bundle always match whatever package.json says.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
  throw new Error('build-client: package.json has no name to inject as the module id')
}

await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(root, 'dist/client.js'),
  legalComments: 'none',
  define: { CLIENT_MODULE_ID: JSON.stringify(manifest.name) },
})
console.log(`dist/client.js  id=${manifest.name}`)
