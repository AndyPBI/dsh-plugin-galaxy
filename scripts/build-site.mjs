#!/usr/bin/env node
/**
 * Build the static Plugin Galaxy site.
 *
 * The site is deliberately dependency-free: `site/` holds plain HTML, and this
 * script copies it to `dist-site/` while substituting the plugin version from
 * package.json. `__VERSION__` placeholders are replaced everywhere they appear,
 * so the published page can never advertise a version the package does not have.
 *
 * Usage: node scripts/build-site.mjs [--out dist-site]
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sourceDir = join(root, 'site')
const outIndex = process.argv.indexOf('--out')
const outDir = resolve(root, outIndex === -1 ? 'dist-site' : (process.argv[outIndex + 1] ?? 'dist-site'))

/** Read the version this build should advertise. */
async function pluginVersion() {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('package.json has no version')
  }
  return manifest.version
}

/** Recursively list files under a directory, relative to it. */
async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listFiles(join(dir, entry.name), relative))
    else files.push(relative)
  }
  return files
}

if (!existsSync(sourceDir)) {
  console.error(`site build ERROR: ${sourceDir} does not exist`)
  process.exit(1)
}

const version = await pluginVersion()
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
await cp(sourceDir, outDir, { recursive: true })

const files = await listFiles(outDir)
let substituted = 0
for (const file of files) {
  if (!/\.(?:html|css|js|json|txt|xml)$/iu.test(file)) continue
  const target = join(outDir, file)
  const text = await readFile(target, 'utf8')
  if (!text.includes('__VERSION__')) continue
  await writeFile(target, text.replaceAll('__VERSION__', version))
  substituted += 1
}

if (!existsSync(join(outDir, 'index.html'))) {
  console.error('site build ERROR: the built site has no index.html')
  process.exit(1)
}

console.log(`site build PASSED: ${files.length} file(s) -> ${outDir} (version ${version}, ${substituted} file(s) versioned)`)
