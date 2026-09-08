/**
 * Seal a gateway bearer token into this machine's store, so the adapter
 * authenticates with it without any plaintext landing on disk:
 *
 *   node seal-token.mjs <token>        seal (reads the token from argv)
 *   node seal-token.mjs --stdin        seal, reading the token from stdin
 *   node seal-token.mjs --show         print where the sealed store lives
 *
 * The blob opens only for the same user on the same machine (DPAPI on
 * Windows, machine-id-derived AES-GCM elsewhere), so copying ~/.dsh or this
 * directory to another machine carries only ciphertext.
 */
import { openSecret, putSecret, sealedStorePath } from './dist/sealed.js'

const args = process.argv.slice(2)
if (args.includes('--show')) {
  console.log('sealed store: ' + sealedStorePath())
  console.log("gateway-token present: " + String(openSecret('gateway-token') !== undefined))
  process.exit(0)
}
const plain = args.includes('--stdin')
  ? (await import('node:readline/promises')).createInterface({ input: process.stdin }).question('').then((r) => r.trim())
  : args[0]
if (typeof plain !== 'string' || plain.length === 0) {
  console.error('usage: node seal-token.mjs <token> | --stdin | --show')
  process.exit(1)
}
putSecret('gateway-token', plain)
console.log('sealed into ' + sealedStorePath() + ' (machine-bound; verify with --show)')
