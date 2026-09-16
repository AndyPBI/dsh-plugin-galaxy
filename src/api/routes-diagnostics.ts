/**
 * Diagnostics endpoints — and.
 *
 * Both endpoints are read-only; neither writes to the profile and neither
 * spawns a process. `/logs` additionally requires a loopback peer rather than
 * a same-origin caller: the browser downloads it with an `<a download>`
 * navigation, which carries no Origin header at all, and the exported text
 * describes the operator's own machine.
 */

import { join } from 'node:path'
import { sendAttachment, sendJson } from '../core/http.ts'
import { exportLogs, logEvent, readPersistentLog } from '../core/log.ts'
import { LOG_FILE, galaxyDir } from '../core/paths.ts'
import type { GalaxyRuntime } from '../core/runtime.ts'
import type { DiagnosticReport } from '../core/types.ts'
import { profileSnapshotLines } from '../domain/check.ts'
import { analyzeProfile } from '../domain/diagnostics.ts'
import type { Router } from './router.ts'

/** Filename the log export is offered as. */
const LOG_FILENAME = 'dsh-plugin-galaxy-log.txt'
/** Content type of the log export (plain text, UTF-8). */
const LOG_CONTENT_TYPE = 'text/plain; charset=utf-8'

/**
 * Register the diagnostics endpoints.
 * @param router - router of the current mount; disposed with the plugin.
 * @param runtime - mount state: profile directory, version and config.
 */
export function registerDiagnosticsRoutes(router: Router, runtime: GalaxyRuntime): void {
  // The diagnostics panel and the `diagnostics` field of
  // `/installed` both consume this report. `analyzeProfile` never throws, so
  // a 500 here can only mean an unexpected internal failure.
  router.get('/dsh-galaxy/check', ({ response }) => {
    try {
      const report: DiagnosticReport = analyzeProfile(runtime.config.profile, runtime.dir)
      sendJson(response, 200, report)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent('error', 'diagnostics', `GET /dsh-galaxy/check failed: ${message}`)
      sendJson(response, 500, { error: message })
    }
  })

  // The issue-report export: environment header, current profile
  // state, this session's events and the tail of the persisted log.
  //
  // The header states versions only. A filesystem path would be scrubbed to
  // `~` by the log sanitizer anyway, but a report that never contains one in
  // the first place is worth more than one that is cleaned up afterwards.
  router.get('/dsh-galaxy/logs', ({ response }) => {
    try {
      const header: Record<string, string> = {
        // Version injected by the host when it mounted this plugin.
        'galaxy version': runtime.version,
        // The same build, labelled with the package that produced it so a
        // maintainer can tell which plugin the report is about.
        plugin: `dsh-plugin-galaxy ${runtime.version}`,
        profile: runtime.config.profile,
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
      }
      const snapshot = profileSnapshotLines(runtime.config.profile, runtime.dir)
      const priorSessions = readPersistentLog(join(galaxyDir(runtime.dir), LOG_FILE))
      const body = exportLogs(header, snapshot, priorSessions)
      sendAttachment(response, LOG_FILENAME, LOG_CONTENT_TYPE, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logEvent('error', 'log-export', `GET /dsh-galaxy/logs failed: ${message}`)
      if (!response.headersSent) sendJson(response, 500, { error: message })
      else response.end()
    }
  }, { loopback: true })
}
