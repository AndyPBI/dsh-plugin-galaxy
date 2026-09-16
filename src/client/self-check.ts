/**
 * Browser-side self-check.
 *
 * Everything the server can report about itself is already in the log; the
 * questions that stall an investigation are the ones only the page can
 * answer: can this browser call `fetch` at all, does `${prefix}/status`
 * answer, is the catalog reachable, and is the client bundle actually the
 * one this UI was built from. Both entry points resolve — never reject —
 * because they are the buttons a broken page still has to offer.
 */

import { downloadTextFile, fetchLogsText, fetchRegistry, fetchStatus } from './market-data.ts'

/** Client bundle id the host serves this plugin under. */
const EXPECTED_BUNDLE_ID = 'dsh-plugin-galaxy'

/** Name of the downloaded log artifact. */
const LOG_FILENAME = 'dsh-plugin-galaxy-log.txt'

/** One short sentence describing a thrown value. */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message
  return String(cause)
}

/**
 * The client bundle ids the page was served, from the boot manifest the host
 * writes (`__DSH_BOOT__.entries`) and from the `/plugins/<id>/client.js`
 * script tags as a fallback.
 * @returns unique ids in discovery order; empty when the page exposes none.
 */
function servedBundleIds(): string[] {
  const ids = new Set<string>()
  const boot = (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__
  if (boot !== null && typeof boot === 'object') {
    const entries = (boot as { entries?: unknown }).entries
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        const id = (entry as { id?: unknown }).id
        if (typeof id === 'string' && id !== '') ids.add(id)
      }
    }
  }
  if (typeof document !== 'undefined') {
    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
      for (const id of idsInComboUrl(script.src)) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Bundle ids inside one script URL. The host batches bundles into a combo URL
 * — `/plugins/??a/client.js,b/client.js&rev=…` — so one tag can carry several
 * ids, scoped names included.
 * @returns the ids found in this URL.
 */
function idsInComboUrl(src: string): string[] {
  const found: string[] = []
  if (typeof src !== 'string' || src === '') return found
  for (const part of src.split(',')) {
    const marker = part.indexOf('/client.js')
    if (marker === -1) continue
    let id = part.slice(0, marker)
    const combo = id.lastIndexOf('??')
    if (combo !== -1) {
      id = id.slice(combo + 2)
    } else {
      const pluginRoot = id.indexOf('/plugins/')
      if (pluginRoot !== -1) id = id.slice(pluginRoot + '/plugins/'.length)
    }
    id = id.replace(/^\/+/, '').trim()
    if (id !== '') found.push(id)
  }
  return found
}

/**
 * Whether the served bundle id matches the id this client was built for.
 * @returns a problem sentence, or null when the page does not contradict it.
 */
function bundleIdProblem(ids: readonly string[]): string | null {
  const galaxy = ids.filter(id => id.toLowerCase().includes('galaxy'))
  if (galaxy.length === 0) {
    // Nothing identifies itself as a galaxy bundle. A page that lists no
    // bundles at all cannot be judged; a page that lists bundles but none of
    // ours is a real finding.
    if (ids.length === 0) return null
    return `no served client bundle id matches ${EXPECTED_BUNDLE_ID} (saw: ${ids.join(', ')})`
  }
  const mismatched = galaxy.filter(id => id !== EXPECTED_BUNDLE_ID && !id.endsWith(`/${EXPECTED_BUNDLE_ID}`))
  if (mismatched.length > 0) {
    return `served client bundle id "${mismatched.join(', ')}" does not match "${EXPECTED_BUNDLE_ID}"`
  }
  return null
}

/**
 * Download the galaxy log.
 *
 * Resolves even when the server half cannot be fetched: the button also lives
 * in the error boundary, and a crash is exactly when it has to answer. A
 * failed fetch still downloads a file, so a press never ends in silence.
 */
export async function exportGalaxyLog(): Promise<void> {
  try {
    const text = await fetchLogsText()
    downloadTextFile(LOG_FILENAME, text)
  } catch (cause) {
    try {
      downloadTextFile(LOG_FILENAME, `Plugin Galaxy log export failed: ${describe(cause)}\n`)
    } catch {
      // No DOM to download into; runSelfCheck() reports the same failure as a
      // problem string for a caller that can show it.
    }
  }
}

/**
 * What this page can verify about itself before a bug report is written.
 * @returns `ok` plus one sentence per problem found; never rejects.
 */
export async function runSelfCheck(): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = []

  if (typeof fetch !== 'function') {
    // Without fetch no other check can say anything useful, so the report
    // stops at the cause instead of listing four consequences of it.
    problems.push('this browser context has no fetch(); the galaxy UI cannot reach its own server')
    return { ok: false, problems }
  }

  try {
    const status = await fetchStatus()
    const version = (status as unknown as { version?: unknown }).version
    if (typeof version !== 'string' || version === '') {
      problems.push('/dsh-galaxy/status answered without a version, so the server is not a galaxy host')
    }
  } catch (cause) {
    problems.push(`/dsh-galaxy/status is unreachable: ${describe(cause)}`)
  }

  try {
    const payload = await fetchRegistry()
    const plugins = (payload as unknown as { registry?: { plugins?: unknown } }).registry?.plugins
    if (!Array.isArray(plugins)) {
      problems.push('/dsh-galaxy/registry answered without a plugin list')
    }
  } catch (cause) {
    problems.push(`/dsh-galaxy/registry is unreachable: ${describe(cause)}`)
  }

  const bundle = bundleIdProblem(servedBundleIds())
  if (bundle !== null) problems.push(bundle)

  return { ok: problems.length === 0, problems }
}
