#!/usr/bin/env node
/**
 * Desensitization / compliance gate.
 *
 * This plugin was designed with the help of a meta-model reverse-engineered from
 * a THIRD-PARTY product. Its internal identifier systems (its table/object/
 * function/endpoint/rule/entry names, its source paths, its product name) must
 * never travel with this package, and neither must credentials or machine-local
 * paths. A comment is enough to leak them: `lib/` is compiled from `src/`, the
 * declaration files keep the doc comments, and the client bundle embeds them too.
 *
 * So this gate scans what SHIPS and what the repository will publish:
 *
 *   A. the packed artifact (the `files` whitelist + README/package.json), by
 *      walking `npm pack --dry-run --json` — the same list npm would publish;
 *   B. the repository surface that a public checkout exposes (src, client,
 *      tests, scripts, docs, site, workflows, README, plantodo, CSS);
 *
 * and fails on any of:
 *
 *   1. the foreign identifier families, whether spelled out (`TBL-catalog`) or
 *      only as a prefix wildcard (`TBL-*`);
 *   2. the foreign product's name or source paths (`dsh-market`, `refer/`);
 *   3. credentials (private keys, `sk-…`, `ghp_…`, `AKIA…`, `xox…`);
 *   4. machine-local absolute paths (`/Users/<name>/…`, `/home/<name>/…`);
 *   5. the reference checkout (`refer/`) leaking into the published file list.
 *
 * Usage: node scripts/check-desensitization.mjs [--dir <workspace>] [--quiet]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argIndex = process.argv.indexOf('--dir')
const workspace = resolve(argIndex === -1 ? join(here, '..') : (process.argv[argIndex + 1] ?? join(here, '..')))
const quiet = process.argv.includes('--quiet')

/** Directories that are never part of the published/repository surface. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-site', 'build', 'coverage', '.npm-cache',
  '.layout-probe', '.probe-cache', 'refer', 'catalog', 'assets', 'tmp',
])

/**
 * Deliberate, per-file carve-outs. The attribution notice NAMES the referenced
 * project on purpose — that is what a copyright notice is — and it is the only
 * place allowed to do so; every other rule still applies to it.
 */
const EXEMPT = new Map([
  ['THIRD-PARTY-NOTICES.md', new Set(['foreign-product'])],
])

/** File types worth scanning (binary formats are skipped wholesale). */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.css', '.md', '.markdown',
  '.yml', '.yaml', '.html', '.txt', '.sh', '.toml', '.patch', '.ndjson',
])

const RULES = [
  {
    id: 'foreign-identifier',
    label: 'identifiers from the reverse-engineered meta-model',
    pattern: /\b(?:TBL|OBJ|FUNC|API|ENTRY|STORE|RULE|MENU|CLIENT|JOB|MOD|SYS)-[a-z0-9][a-z0-9-]*/gu,
    hint: 'describe the module in its own words; keep any mapping outside the repository',
  },
  {
    id: 'foreign-identifier-prefix',
    label: 'the families the foreign identifier system was built from, even as a wildcard',
    // `TBL-*` names the scheme without naming an entry: still the other
    // product's vocabulary, and exactly what a "we cleaned this up" note tends
    // to quote back into the repository.
    pattern: /\b(?:TBL|OBJ|FUNC|API|ENTRY|STORE|RULE|MENU|CLIENT|JOB|MOD|SYS)-\*/gu,
    hint: 'describe the categories in words (tables / objects / functions / endpoints / …)',
  },
  {
    id: 'foreign-product',
    label: 'the third-party product name or its source paths',
    pattern: /\bdsh-market\b|\bdshmarket\b|\brefer\//gu,
    hint: 'the package must not name the product it was designed after',
  },
  {
    id: 'credential',
    label: 'a credential-shaped string',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
    hint: 'rotate the credential and remove it from the file (and from history)',
  },
  {
    id: 'local-path',
    label: 'a machine-local absolute path',
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//gu,
    hint: 'use `~` / a placeholder, or read the path from the environment',
  },
]

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    if (!quiet) console.log(`PASS  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * A. the published file list
 * ------------------------------------------------------------------ */

function packedFiles() {
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, npm_config_cache: join(workspace, '.npm-cache') },
    })
    const parsed = JSON.parse(output)
    const entry = Array.isArray(parsed) ? parsed[0] : parsed
    return (entry?.files ?? []).map(file => file.path)
  } catch {
    return undefined
  }
}

const packed = packedFiles()
if (packed === undefined) {
  check('the published file list could be read (`npm pack --dry-run --json`)', false,
    'npm pack failed; run `npm install` first')
} else {
  const paths = packed.map(path => String(path))
  check('the published file list could be read (`npm pack --dry-run --json`)', paths.length > 0, `${String(paths.length)} file(s)`)
  const forbidden = paths.filter(path => /^(?:refer|catalog|site|dist-site|docs|tests|scripts)\//u.test(path))
  check('the published file list carries no reference checkout or internal-only tree',
    forbidden.length === 0, forbidden.slice(0, 5).join(', '))
}

/* ------------------------------------------------------------------ *
 * B. the repository surface
 * ------------------------------------------------------------------ */

function walk(dir, into = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') && entry !== '.github') continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      if (entry === '.git') continue
      walk(full, into)
      continue
    }
    if (stats.size > 2_000_000) continue
    const dot = entry.lastIndexOf('.')
    if (dot === -1 || !TEXT_EXT.has(entry.slice(dot).toLowerCase())) continue
    into.push(full)
  }
  return into
}

const files = walk(workspace)
const hits = new Map()

for (const file of files) {
  // This file DEFINES the patterns it looks for, so it would always match itself.
  if (file === join(workspace, 'scripts', 'check-desensitization.mjs')) continue
  const source = readFileSync(file, 'utf8')
  const exempt = EXEMPT.get(relative(workspace, file)) ?? new Set()
  for (const rule of RULES) {
    if (exempt.has(rule.id)) continue
    for (const match of source.matchAll(rule.pattern)) {
      const lineText = source.slice(source.lastIndexOf('\n', match.index) + 1, source.indexOf('\n', match.index))
      // A deliberate fixture (the log sanitizer needs a credential-shaped input)
      // carries `compliance-allow: <rule-id>` on the same line.
      if (lineText.includes(`compliance-allow: ${rule.id}`)) continue
      const at = source.slice(0, match.index).split('\n').length
      const key = `${rule.id}\u0000${relative(workspace, file)}:${String(at)}`
      if (!hits.has(key)) hits.set(key, { rule, file: relative(workspace, file), line: at, text: match[0] })
    }
  }
}

for (const rule of RULES) {
  const found = [...hits.values()].filter(hit => hit.rule.id === rule.id)
  check(`${rule.label} are absent`, found.length === 0,
    found.length === 0
      ? `${String(files.length)} file(s) scanned`
      : `${String(found.length)} hit(s): ${found.slice(0, 3).map(hit => `${hit.file}:${String(hit.line)} (${hit.text})`).join('; ')} — ${rule.hint}`)
}

/* ------------------------------------------------------------------ *
 * C. the git ignore list keeps the reference checkout local
 * ------------------------------------------------------------------ */

const gitignore = existsSync(join(workspace, '.gitignore'))
  ? readFileSync(join(workspace, '.gitignore'), 'utf8')
  : ''
for (const entry of ['refer/', 'catalog/']) {
  check(`\`.gitignore\` excludes \`${entry}\``, new RegExp(`^${entry.replace('/', '\\/')}$`, 'mu').test(gitignore),
    `a public checkout must not carry ${entry}`)
}

console.log('')
console.log(failures === 0
  ? `DESENSITIZATION: PASS — ${String(files.length)} file(s) scanned, ${String(packed?.length ?? 0)} published`
  : `DESENSITIZATION: FAIL (${String(failures)})`)
process.exit(failures === 0 ? 0 : 1)
