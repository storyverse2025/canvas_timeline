import { existsSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const file = resolve(here, '.env')
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i)
    if (!m) continue
    const [, k, raw] = m
    if (process.env[k] != null && process.env[k] !== '') continue
    process.env[k] = raw.replace(/^['"]|['"]$/g, '')
  }
}
