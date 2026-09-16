#!/usr/bin/env node
/**
 * Distribution integrity gate — run before installing into a DeepSeek Harness
 * profile.
 *
 * Checks the packaged artifact against what the host loader and the DSH CLI
 * actually require:
 *
 *  1. `package.json` `main` / `types` / `exports` / `dsh.bundle.patch` targets
 *     exist on disk (a wrong path is a silent "plugin does not load").
 *  2. `dsh.bundle.patch` is declared at all — `dsh plugin add` only appends a
 *     dependency to `dsh.profile.bundles` when the installed package declares
 *     `dsh.bundle.patch`; without it the plugin installs as a plain library
 *     and never activates.
 *  3. every relative import inside `lib/` resolves to an emitted file.
 *  4. every bare specifier in `lib/` is a declared dependency, a peer, or a
 *     node builtin (an undeclared import throws at the host's import time).
 *  5. `lib/index.js` exports `name` (matching the package name) and `apply`.
 *  6. `client/client.js` exists, carries the loader banner with the package id,
 *     and declares no external the platform module table cannot answer.
 *
 * Usage: node scripts/verify-dist.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Baseline rows of the browser loader module table (packages/client/web/src/platform.ts). */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Local dependencies a browser bundle may inline (installed by npm). */
const INLINE_SAFE_PREFIXES = ['lightningcss']

const problems = []
const fail = (message) => problems.push(message)
const ok = (message) => console.log(`ok    ${message}`)

/* ---- 1. manifest targets exist ------------------------------------- */

const target = (label, relPath) => {
  if (typeof relPath !== 'string' || relPath === '') return fail(`${label} is not a string`)
  if (!existsSync(join(root, relPath))) fail(`${label} points at a missing file: ${relPath}`)
  else ok(`${label} -> ${relPath}`)
}

target('main', manifest.main)
target('types', manifest.types)
target('dsh.bundle.patch', manifest.dsh?.bundle?.patch)
target('exports["./client"]', manifest.exports?.['./client'])
target('exports["."].default', manifest.exports?.['.']?.default)
target('exports["."].types', manifest.exports?.['.']?.types)

/* ---- 2. the load-bearing manifest fields --------------------------- */

if (manifest.dsh?.bundle?.patch === undefined) {
  fail('dsh.bundle.patch is missing: `dsh plugin add` will install this as a plain dependency and it will never load')
} else {
  ok('dsh.bundle.patch declared (the package can become a profile bundle layer)')
}

if (manifest.dsh?.client?.platform !== 'web') {
  fail(`dsh.client.platform must be "web" for the web consumer, got ${JSON.stringify(manifest.dsh?.client?.platform)}`)
} else {
  ok('dsh.client.platform = web')
}

if (manifest.type !== 'module') fail('package "type" must be "module" for the ESM node half')
else ok('package type is module (ESM node half)')

/* ---- helpers -------------------------------------------------------- */

/** Recursively collect files under a directory. */
function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, filter, out)
    else if (filter(full)) out.push(full)
  }
  return out
}

/** Extract every module specifier from source text: static import/export-from plus literal require(). */
function specifiersOf(source) {
  const found = new Set()
  for (const match of source.matchAll(/(?:^|[\s;{(])(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
    found.add(match[1])
  }
  for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(match[1])
  for (const match of source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(match[1])
  return [...found]
}

const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
])

const packageNameOf = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

/* ---- 3 & 4. node half imports -------------------------------------- */

const jsFiles = walk(join(root, 'lib'), file => extname(file) === '.js')
if (jsFiles.length === 0) fail('lib/ contains no JavaScript (run npm run build)')
for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8')
  for (const specifier of specifiersOf(source)) {
    if (specifier.startsWith('node:')) continue
    if (specifier.startsWith('.')) {
      const resolved = resolve(dirname(file), specifier)
      if (!existsSync(resolved)) {
        // A dynamic specifier built from a template (the sibling loader) is not
        // statically resolvable; the runtime smoke test covers that path.
        if (specifier.includes('${')) continue
        fail(`${relative(root, file)} imports ${specifier}, which does not exist`)
      }
      continue
    }
    if (isBuiltin(specifier)) continue
    if (!declared.has(packageNameOf(specifier))) {
      fail(`${relative(root, file)} imports undeclared package "${specifier}"`)
    }
  }
}
ok(`lib/: ${String(jsFiles.length)} module(s) checked for resolvable imports`)

/* ---- 5. node-half entry exports ------------------------------------ */

try {
  const entry = await import(join(root, manifest.main))
  if (entry.name !== manifest.name) {
    fail(`lib entry exports name ${JSON.stringify(entry.name)}, expected ${JSON.stringify(manifest.name)}`)
  } else ok(`lib entry exports name = ${manifest.name}`)
  if (typeof entry.apply !== 'function') fail('lib entry does not export apply()')
  else ok('lib entry exports apply()')
} catch (error) {
  fail(`lib entry cannot be imported: ${String(error?.message ?? error)}`)
}

/* ---- 6. client bundle ---------------------------------------------- */

const clientPath = manifest.exports?.['./client']
if (typeof clientPath === 'string' && existsSync(join(root, clientPath))) {
  const bundle = readFileSync(join(root, clientPath), 'utf8')
  // tsdown pretty-prints the banner across lines, so compare whitespace-normalized text.
  const flat = bundle.replace(/\s+/g, ' ')
  const expectedBanner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory:`
  if (!flat.includes(expectedBanner.replace(/\s+/g, ' '))) {
    fail(`client bundle banner does not register id ${JSON.stringify(manifest.name)}`)
  } else ok('client bundle carries the loader banner with the package id')

  const externals = new Set()
  for (const match of bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) externals.add(match[1])
  const unanswered = [...externals].filter(specifier =>
    !PLATFORM_MODULES.has(specifier)
    && !specifier.startsWith('.')
    && !INLINE_SAFE_PREFIXES.some(prefix => specifier.startsWith(prefix)))
  if (unanswered.length > 0) {
    fail(`client bundle requires specifiers the platform module table cannot answer: ${unanswered.join(', ')}`)
  } else {
    ok(`client bundle externals all answerable by the module table (${[...externals].join(', ')})`)
  }

  /* `files` must actually publish the artifact. */
  const published = manifest.files ?? []
  const clientDir = clientPath.replace(/^\.\//, '').split('/')[0]
  if (!published.includes(clientDir)) fail(`package "files" does not include "${clientDir}" (the client artifact would not ship)`)
  else ok(`package "files" publishes ${clientDir}/`)
} else {
  fail('client bundle is missing (run npm run build:client)')
}

if (!(manifest.files ?? []).includes('lib')) fail('package "files" does not include "lib" (the node half would not ship)')

/* ---- 7. declaration specifiers ------------------------------------- */

const declarations = walk(join(root, 'lib/types'), file => file.endsWith('.d.ts'))
const badDeclarations = declarations.filter(file => /from\s+['"][^'"]+\.ts['"]/.test(readFileSync(file, 'utf8')))
if (badDeclarations.length > 0) {
  fail(`${String(badDeclarations.length)} declaration file(s) import a .ts specifier (breaks consumer typechecking); run npm run fix:declarations`)
} else {
  ok(`lib/types: ${String(declarations.length)} declaration file(s) use resolvable specifiers`)
}

/* ---- report --------------------------------------------------------- */

if (problems.length > 0) {
  console.error(`\nDIST VERIFY: FAIL (${String(problems.length)} problem(s))`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\nDIST VERIFY: PASS')
