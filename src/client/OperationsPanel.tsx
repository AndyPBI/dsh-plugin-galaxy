/**
 * The floating activity panel (
 * ,).
 *
 * The panel is deliberately detached from the plugin grid: a record — and the
 * decision attached to it — has to survive paginating, searching and
 * switching tabs. It reads records through the pure model in `operations.ts`
 * and never keeps operation state of its own, so a rollback, a cancellation
 * and a build approval all reach the parent that owns the queue.
 *
 * Every action here is offered only where it can succeed: rollback needs a
 * rollback token (the server mints one per mutation and refuses any token it
 * did not issue), cancel needs a running record, "allow build scripts" needs
 * the blocked package list, and pnpm provisioning is only suggested on a
 * failure the status probe flagged as pnpm-missing.
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import type { Translate } from './locales-settings.ts'
import type { OperationRecord } from './market-data.ts'
import { bucketOf, groupRecords } from './operations.ts'

/**
 * The fields this panel reads. The server DTO is read structurally so that
 * the two client-only annotations (`rollbackId`, `pnpmMissing`) work whether
 * or not the transport type spells them out.
 */
interface RowView {
  id: string
  kind: string
  name: string
  state: string
  percent?: number | null | undefined
  detail?: string | undefined
  reason?: string | undefined
  blockedBuilds?: string[] | undefined
  needsRefresh?: boolean | undefined
  /**
   * Rollback token for this record. The server mints an opaque
   * `rollback-<…>` token per mutation; a view that threads it onto the record
   * may use the request field name (`rollbackId`), the response field name
   * (`rollbackToken`), or — when the token IS the record id — neither.
   */
  rollbackId?: string | undefined
  rollbackToken?: string | undefined
  /** True when /status reported pnpm unusable — offers the provision action. */
  pnpmMissing?: boolean | undefined
}

/** Read one record through the panel's structural view. */
function viewOf(record: OperationRecord): RowView {
  return record as unknown as RowView
}

/**
 * The rollback token a record carries, or null when it carries none.
 *
 * A record without one gets no rollback action: the route refuses a token it
 * never minted, so the button could only ever fail. The server's own token
 * shape is the strongest signal; an explicitly named token field is accepted
 * whatever it looks like.
 */
function rollbackTokenOf(row: RowView): string | null {
  for (const value of [row.rollbackId, row.rollbackToken, row.id]) {
    if (typeof value === 'string' && value.startsWith('rollback-')) return value
  }
  for (const value of [row.rollbackId, row.rollbackToken]) {
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** Whether the host may still be working on the record. */
function isBusyState(state: string): boolean {
  return state === 'running' || state === 'queued'
}

/** One record row: identity, progress, outcome and the actions it allows. */
function OperationRow(props: {
  t: Translate
  record: OperationRecord
  cancelling: boolean
  onRollback: (record: OperationRecord) => void
  onCancel: () => void
  onApproveBuilds: (packages: string[]) => void
  onSetupPnpm: () => void
}): ReactElement {
  const { t, record, cancelling } = props
  const row = viewOf(record)
  const blocked = row.blockedBuilds ?? []
  const rollbackId = rollbackTokenOf(row)
  const settled = !isBusyState(row.state)
  const percent = typeof row.percent === 'number' ? row.percent : null

  return (
    <div className={css.row} data-record={row.id}>
      <div className={css.sectionHeader}>
        <span className={css.badge}>{t(`opKind_${row.kind}`)}</span>
        <span>{row.name}</span>
        <span className={bucketOf(record) === 'attention' ? css.danger : css.muted}>
          {t(`opState_${row.state}`)}
        </span>
      </div>

      {percent !== null ? (
        <div className={css.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span className={css.badge}>{percent}%</span>
        </div>
      ) : null}

      {row.detail !== undefined && row.detail !== '' ? <p className={css.muted}>{row.detail}</p> : null}
      {row.reason !== undefined && row.reason !== '' ? (
        <p className={bucketOf(record) === 'attention' ? css.danger : css.muted}>{row.reason}</p>
      ) : null}

      {blocked.length > 0 ? (
        <p className={css.danger}>
          {t('opApproveBuildsHint')}: {blocked.join(', ')}
        </p>
      ) : null}

      {settled && row.state === 'done' && row.needsRefresh === true ? (
        <p className={css.muted}>{t('opNeedsRefresh')}</p>
      ) : null}

      <div className={css.toolbar}>
        {rollbackId !== null && settled ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => { props.onRollback(record) }}
          >{t('opRollback')}</Button>
        ) : null}
        {row.state === 'running' ? (
          <Button
            variant="outline"
            size="sm"
            disabled={cancelling}
            onClick={props.onCancel}
          >{cancelling ? t('opCancelling') : t('opCancel')}</Button>
        ) : null}
        {row.state === 'failed' && blocked.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => { props.onApproveBuilds(blocked) }}
          >{t('opApproveBuilds')}</Button>
        ) : null}
        {row.state === 'failed' && blocked.length === 0 && row.pnpmMissing === true ? (
          <Button
            variant="primary"
            size="sm"
            onClick={props.onSetupPnpm}
          >{t('opSetupPnpm')}</Button>
        ) : null}
      </div>
    </div>
  )
}

/** One bucket of the panel; renders nothing when its list is empty. */
function Group(props: {
  t: Translate
  title: string
  records: OperationRecord[]
  cancelling: boolean
  onRollback: (record: OperationRecord) => void
  onCancel: () => void
  onApproveBuilds: (packages: string[]) => void
  onSetupPnpm: () => void
}): ReactElement | null {
  if (props.records.length === 0) return null
  return (
    <section className={css.card}>
      <div className={css.sectionHeader}>
        <span>{props.title}</span>
        <span className={css.badge}>{props.records.length}</span>
      </div>
      {props.records.map(record => (
        <OperationRow
          key={viewOf(record).id}
          t={props.t}
          record={record}
          cancelling={props.cancelling}
          onRollback={props.onRollback}
          onCancel={props.onCancel}
          onApproveBuilds={props.onApproveBuilds}
          onSetupPnpm={props.onSetupPnpm}
        />
      ))}
    </section>
  )
}

export function OperationsPanel(props: {
  t: Translate
  records: readonly OperationRecord[]
  onRollback: (record: OperationRecord) => void
  onCancel: () => void
  onApproveBuilds: (packages: string[]) => void
  onSetupPnpm: () => void
}): ReactElement {
  const { t, records } = props
  const [open, setOpen] = useState(false)
  /**
   * Cancellation is a request, not a state transition: the record only leaves
   * `running` once the host has stopped the child. Disabling the button in the
   * meantime is what keeps a second click from queueing a second signal.
   */
  const [cancelling, setCancelling] = useState(false)
  const anyRunning = records.some(record => viewOf(record).state === 'running')

  useEffect(() => {
    if (!anyRunning) setCancelling(false)
  }, [anyRunning])

  const groups = groupRecords(records)
  const attention = groups.attention.length
  const running = groups.busy.length

  return (
    <div className={css.panel} data-entry="operations">
      <button
        type="button"
        className={css.toolbar}
        aria-expanded={open}
        aria-label={t(open ? 'opHide' : 'opShow')}
        onClick={() => { setOpen(current => !current) }}
      >
        <span>{t('opTitle')}</span>
        {running > 0 ? <span className={css.spinner} aria-hidden="true" /> : null}
        {records.length > 0 ? <span className={css.badge}>{records.length}</span> : null}
        {attention > 0 ? <span className={css.danger}>{attention}</span> : null}
      </button>

      {open ? (
        <div className={css.root}>
          {records.length === 0 ? (
            <div className={css.empty}>
              <div>{t('opEmpty')}</div>
              <div className={css.muted}>{t('opEmptyHint')}</div>
            </div>
          ) : (
            <>
              <Group
                t={t}
                title={t('opAttentionTitle')}
                records={groups.attention}
                cancelling={cancelling}
                onRollback={props.onRollback}
                onCancel={() => { setCancelling(true); props.onCancel() }}
                onApproveBuilds={props.onApproveBuilds}
                onSetupPnpm={props.onSetupPnpm}
              />
              <Group
                t={t}
                title={t('opBusyTitle')}
                records={groups.busy}
                cancelling={cancelling}
                onRollback={props.onRollback}
                onCancel={() => { setCancelling(true); props.onCancel() }}
                onApproveBuilds={props.onApproveBuilds}
                onSetupPnpm={props.onSetupPnpm}
              />
              <Group
                t={t}
                title={t('opOkTitle')}
                records={groups.ok}
                cancelling={cancelling}
                onRollback={props.onRollback}
                onCancel={() => { setCancelling(true); props.onCancel() }}
                onApproveBuilds={props.onApproveBuilds}
                onSetupPnpm={props.onSetupPnpm}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
