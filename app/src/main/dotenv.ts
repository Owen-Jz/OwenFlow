/**
 * Minimal .env loader (no dotenv dep).
 *
 * Reads `<app>/.env` if it exists and copies any `KEY=value` pairs into
 * `process.env`. Existing process.env values WIN — anything already set in
 * the shell or by Electron is left alone, so .env never silently shadows a
 * deliberate override.
 *
 * Imported as a side-effect from `index.ts` BEFORE any module that reads
 * `process.env.OWENFLOW_*`. Failure is non-fatal: missing/malformed .env
 * just means nothing is loaded.
 *
 * Format:
 *   KEY=value           # plain
 *   KEY="quoted value"  # quotes stripped, no escape processing
 *   # comment lines and blank lines ignored
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function findEnvFile(): string | null {
  // Dev: cwd is usually <repo>/app; packaged: resourcesPath / appPath.
  const candidates = [
    join(process.cwd(), '.env'),
    join(__dirname, '..', '..', '.env')
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

function loadDotenv(): void {
  const path = findEnvFile()
  if (!path) return

  try {
    const text = readFileSync(path, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      // Strip surrounding single or double quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      // Shell-set vars win; never clobber a deliberate override.
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
    console.log(`[dotenv] loaded ${path}`)
  } catch (err) {
    console.warn('[dotenv] failed to load .env:', err)
  }
}

loadDotenv()
