#!/usr/bin/env node
/**
 * Rewrite `.ts` import specifiers inside the emitted declaration files.
 *
 * `tsc` rewrites relative `.ts` specifiers to `.js` in the emitted JavaScript,
 * but the matching `.d.ts` files keep the source spelling. A consumer that
 * resolves `lib/types/index.d.ts` then hits `import ... from '../domain/x.ts'`,
 * which only typechecks with `allowImportingTsExtensions` — so the published
 * `types` entry is unusable out of the box.
 *
 * This runs as part of `npm run build`, right after `tsc`, and rewrites those
 * specifiers to their emitted `.js` counterparts so the declarations resolve
 * like the code they describe.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const typesDir = join(root, 'lib/types')

/** Recursively collect files under a directory. */
function walk(dir, filter, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, filter, out)
    else if (filter(full)) out.push(full)
  }
  return out
}

/** `from './x.ts'`, `import('./y.ts')`, `import type { T } from '../z.ts'`. */
const SPECIFIER = /(['"])(\.[^'"]*?)\.ts\1/g

let rewritten = 0
let files = 0
for (const file of walk(typesDir, candidate => candidate.endsWith('.d.ts'))) {
  const source = readFileSync(file, 'utf8')
  if (!source.includes('.ts')) continue
  const updated = source.replace(SPECIFIER, '$1$2.js$1')
  if (updated === source) continue
  writeFileSync(file, updated)
  files += 1
  rewritten += (source.match(SPECIFIER) ?? []).length
}

console.log(`declaration imports fixed: ${String(rewritten)} specifier(s) across ${String(files)} file(s)`)
