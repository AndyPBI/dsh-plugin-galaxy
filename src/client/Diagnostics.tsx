/**
 * The profile diagnostic report.
 *
 * Read-only: the report arrives as a prop (the parent owns fetching, so the
 * panel can be rendered from the section, from a test, or from a cached
 * payload without a second round trip). Fields are read structurally — a host
 * from before a field existed leaves it undefined and the panel degrades to a
 * shorter table instead of a blank frame.
 *
 * The report is layered on purpose: errors, then warnings, then info, each
 * finding keeping the server's stable `code` so a user can quote it in a bug
 * report.
 */

import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import type { Translate } from './locales-settings.ts'
import type { DiagnosticReport } from './market-data.ts'

/** The subset of this panel renders. */
interface DiagnosticView {
  profile?: string | undefined
  hostVersion?: string | undefined
  generatedAt?: string | undefined
  summary?: {
    errors?: number | undefined
    warnings?: number | undefined
    packages?: number | undefined
    bundles?: number | undefined
  } | undefined
  bundles?: Array<{ name?: string | undefined; resolved?: boolean | undefined; reason?: string | undefined }> | undefined
  peerMismatches?: Array<{
    name?: string | undefined
    requirement?: string | undefined
    resolved?: string | undefined
    verdict?: string | undefined
  }> | undefined
  duplicateNames?: string[] | undefined
  findings?: Array<{
    level?: string | undefined
    code?: string | undefined
    message?: string | undefined
    names?: string[] | undefined
  }> | undefined
}

/** Finding levels, worst first — the order a reader scans them in. */
const LEVELS: readonly string[] = ['error', 'warn', 'info']

/** Read the transport DTO through the panel's structural view. */
function viewOf(report: DiagnosticReport): DiagnosticView {
  return report as unknown as DiagnosticView
}

/** `generatedAt` is an ISO string when the server sent one. */
function formatTime(value: string | undefined, fallback: string): string {
  if (value === undefined || value === '') return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** The localized label of a finding level, or the raw level when unknown. */
function levelLabel(t: Translate, level: string): string {
  return LEVELS.includes(level) ? t(`diagLevel_${level}`) : level
}

/** A verdict badge: anything but `satisfied` is worth a second look. */
function Verdict(props: { t: Translate; verdict: string }): ReactElement {
  const { t, verdict } = props
  const known = ['satisfied', 'mismatch', 'missing', 'unknown'].includes(verdict)
  const className = verdict === 'satisfied' ? css.muted : css.danger
  return <span className={className}>{known ? t(`diagVerdict_${verdict}`) : verdict}</span>
}

/** One labelled count of the report summary. */
function Count(props: { label: string; value: number; danger?: boolean }): ReactElement {
  return (
    <span className={props.danger === true && props.value > 0 ? css.danger : css.muted}>
      {props.label} <span className={css.badge}>{props.value}</span>
    </span>
  )
}

export function Diagnostics(props: {
  t: Translate
  report: DiagnosticReport | null
  onRefresh: () => void
}): ReactElement {
  const { t, report, onRefresh } = props

  if (report === null) {
    return (
      <div className={css.card} data-entry="diagnostics">
        <div className={css.sectionHeader}>
          <span>{t('diagTitle')}</span>
          <Button variant="outline" size="sm" onClick={onRefresh}>{t('diagRun')}</Button>
        </div>
        <p className={css.muted}>{t('diagHint')}</p>
        <div className={css.empty}>
          <div>{t('diagNotRun')}</div>
          <div className={css.muted}>{t('diagNotRunHint')}</div>
        </div>
      </div>
    )
  }

  const view = viewOf(report)
  const summary = view.summary
  const bundles = view.bundles ?? []
  const peers = view.peerMismatches ?? []
  const duplicates = view.duplicateNames ?? []
  const findings = view.findings ?? []

  return (
    <div className={css.card} data-entry="diagnostics">
      <div className={css.sectionHeader}>
        <span>{t('diagTitle')}</span>
        <span className={css.badge}>{t('diagErrors')} {summary?.errors ?? 0}</span>
        <span className={css.badge}>{t('diagWarnings')} {summary?.warnings ?? 0}</span>
        <Button variant="outline" size="sm" onClick={onRefresh}>{t('diagRefresh')}</Button>
      </div>
      <p className={css.muted}>{t('diagHint')}</p>

      <div className={css.row}>
        <span className={css.muted}>{t('diagProfile')}: {view.profile ?? '—'}</span>
        <span className={css.muted}>{t('diagHostVersion')}: {view.hostVersion ?? '—'}</span>
        <span className={css.muted}>
          {t('diagGeneratedAt')}: {formatTime(view.generatedAt, '—')}
        </span>
      </div>

      <div className={css.toolbar}>
        <Count label={t('diagErrors')} value={summary?.errors ?? 0} danger />
        <Count label={t('diagWarnings')} value={summary?.warnings ?? 0} />
        <Count label={t('diagPackages')} value={summary?.packages ?? 0} />
        <Count label={t('diagBundles')} value={summary?.bundles ?? bundles.length} />
      </div>

      <section className={css.row}>
        <div className={css.sectionHeader}>{t('diagBundlesTitle')}</div>
        {bundles.length === 0 ? (
          <p className={css.muted}>{t('diagEmpty')}</p>
        ) : (
          <table className={css.table}>
            <thead>
              <tr>
                <th scope="col">{t('diagBundleName')}</th>
                <th scope="col">{t('diagBundleResolved')}</th>
                <th scope="col">{t('diagBundleReason')}</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((bundle, index) => (
                <tr key={`${bundle.name ?? 'bundle'}:${String(index)}`}>
                  <td>{bundle.name ?? '—'}</td>
                  <td className={bundle.resolved === true ? css.muted : css.danger}>
                    {bundle.resolved === true ? t('diagResolvedYes') : t('diagResolvedNo')}
                  </td>
                  <td className={css.muted}>{bundle.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={css.row}>
        <div className={css.sectionHeader}>
          <span>{t('diagPeersTitle')}</span>
          {peers.length > 0 ? <span className={css.badge}>{peers.length}</span> : null}
        </div>
        {peers.length === 0 ? (
          <p className={css.muted}>{t('diagEmpty')}</p>
        ) : (
          <table className={css.table}>
            <thead>
              <tr>
                <th scope="col">{t('diagPeerName')}</th>
                <th scope="col">{t('diagPeerRequirement')}</th>
                <th scope="col">{t('diagPeerResolved')}</th>
                <th scope="col">{t('diagPeerVerdict')}</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer, index) => (
                <tr key={`${peer.name ?? 'peer'}:${String(index)}`}>
                  <td>{peer.name ?? '—'}</td>
                  <td className={css.muted}>{peer.requirement ?? '—'}</td>
                  <td className={css.muted}>{peer.resolved ?? '—'}</td>
                  <td><Verdict t={t} verdict={peer.verdict ?? 'unknown'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={css.row}>
        <div className={css.sectionHeader}>
          <span>{t('diagDuplicatesTitle')}</span>
          {duplicates.length > 0 ? <span className={css.badge}>{duplicates.length}</span> : null}
        </div>
        {duplicates.length === 0 ? (
          <p className={css.muted}>{t('diagDuplicatesNone')}</p>
        ) : (
          <p className={css.danger}>{duplicates.join(', ')}</p>
        )}
      </section>

      <section className={css.row}>
        <div className={css.sectionHeader}>
          <span>{t('diagFindingsTitle')}</span>
          {findings.length > 0 ? <span className={css.badge}>{findings.length}</span> : null}
        </div>
        {findings.length === 0 ? (
          <p className={css.muted}>{t('diagFindingsNone')}</p>
        ) : (
          LEVELS.map(level => {
            const group = findings.filter(finding => finding.level === level)
            if (group.length === 0) return null
            return (
              <div key={level} className={css.row}>
                <div className={css.sectionHeader}>
                  <span className={level === 'error' ? css.danger : css.muted}>{levelLabel(t, level)}</span>
                  <span className={css.badge}>{group.length}</span>
                </div>
                {group.map((finding, index) => (
                  <div key={`${finding.code ?? level}:${String(index)}`} className={css.row}>
                    {finding.code !== undefined && finding.code !== ''
                      ? <span className={css.badge}>{finding.code}</span>
                      : null}
                    <span>{finding.message ?? ''}</span>
                    {(finding.names ?? []).length > 0
                      ? <span className={css.muted}>{(finding.names ?? []).join(', ')}</span>
                      : null}
                  </div>
                ))}
              </div>
            )
          })
        )}
      </section>
    </div>
  )
}
