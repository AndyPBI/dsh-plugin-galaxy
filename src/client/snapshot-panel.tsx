/**
 * Profile snapshots.
 *
 * A snapshot captures `package.json`, `cordis.patch.yml` and
 * `.dsh-galaxy/state.json` before a risky change; restoring one is the way
 * back from a composition that will not boot. Because a restore overwrites
 * live files, it is a two-step action, and because snapshots are the only
 * record of "what it looked like before", a delete is confirmed too.
 *
 * The panel is hosted by the host's `Modal` primitive, loads lazily on first
 * open, and reports every mutation through `onChanged` so the diagnostics
 * report the user is looking at does not describe the previous profile.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import type { Translate } from './locales-settings.ts'
import { isGalaxyApiError, deleteSnapshotFile, listSnapshots, restoreSnapshotFile, createSnapshot } from './market-data.ts'
import type { ProfileSnapshot } from './market-data.ts'

/** Inline result of the last mutation. */
interface Notice {
  kind: 'ok' | 'bad'
  text: string
}

/** One sentence for a failed call: the server's own message when it sent one. */
function messageOf(cause: unknown, t: Translate): string {
  if (isGalaxyApiError(cause)) {
    const payload = cause.payload
    if (payload !== null && typeof payload === 'object') {
      const record = payload as { error?: unknown; reason?: unknown; message?: unknown }
      for (const value of [record.error, record.reason, record.message]) {
        if (typeof value === 'string' && value !== '') return value
      }
    }
    return `HTTP ${String(cause.status)}`
  }
  if (cause instanceof Error && cause.message !== '') return cause.message
  return t('setFail')
}

/** A snapshot's creation time, or its raw value when it will not parse. */
function formatTime(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export function SnapshotPanel(props: {
  t: Translate
  open: boolean
  onClose: () => void
  onChanged?: () => void
}): ReactElement {
  const { t, open, onClose, onChanged } = props
  const [snapshots, setSnapshots] = useState<ProfileSnapshot[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** Snapshot id awaiting the second click of a restore, or null. */
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null)
  /** Snapshot id awaiting the second click of a delete, or null. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const loaded = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await listSnapshots()
      setSnapshots(Array.isArray(list) ? list : [])
      loaded.current = true
      setNotice(null)
    } catch (cause) {
      // Marked unloaded so the next expand retries: a transient failure must
      // not leave the panel permanently empty.
      loaded.current = false
      setNotice({ kind: 'bad', text: `${t('snapListFail')}: ${messageOf(cause, t)}` })
    }
  }, [t])

  useEffect(() => {
    if (!open || loaded.current) return
    void load()
  }, [open, load])

  const create = useCallback((): void => {
    if (pending !== null) return
    setPending('create')
    setNotice(null)
    void (async () => {
      try {
        await createSnapshot()
        setNotice({ kind: 'ok', text: t('snapCreated') })
        await load()
        onChanged?.()
      } catch (cause) {
        setNotice({ kind: 'bad', text: `${t('snapCreateFail')}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [load, onChanged, pending, t])

  const restore = useCallback((id: string): void => {
    if (pending !== null) return
    setPending('restore')
    setNotice(null)
    void (async () => {
      try {
        await restoreSnapshotFile(id)
        setConfirmRestore(null)
        setNotice({ kind: 'ok', text: t('snapRestored') })
        await load()
        onChanged?.()
      } catch (cause) {
        setNotice({ kind: 'bad', text: `${t('snapRestoreFail')}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [load, onChanged, pending, t])

  const remove = useCallback((id: string): void => {
    if (pending !== null) return
    setPending('delete')
    setNotice(null)
    void (async () => {
      try {
        await deleteSnapshotFile(id)
        setConfirmDelete(null)
        setNotice({ kind: 'ok', text: t('snapDeleted') })
        await load()
        onChanged?.()
      } catch (cause) {
        setNotice({ kind: 'bad', text: `${t('snapDeleteFail')}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [load, onChanged, pending, t])

  const busy = pending !== null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('snapTitle')}
      closeLabel={t('setClose')}
      footer={<Button variant="ghost" size="sm" onClick={onClose}>{t('setClose')}</Button>}
    >
      <div className={css.modalBody} data-entry="snapshot-panel">
        <p className={css.muted}>{t('snapHint')}</p>

        <div className={css.toolbar}>
          <Button variant="primary" size="sm" disabled={busy} onClick={create}>
            {pending === 'create' ? t('snapCreating') : t('snapCreate')}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void load() }}>
            {t('setRefresh')}
          </Button>
        </div>

        {notice !== null ? (
          <p className={notice.kind === 'bad' ? css.danger : css.muted} role={notice.kind === 'bad' ? 'alert' : 'status'}>
            {notice.text}
          </p>
        ) : null}

        {snapshots.length === 0 ? (
          <div className={css.empty}>{t('snapEmpty')}</div>
        ) : (
          <div className={css.root}>
            {snapshots.map(snapshot => (
              <div key={snapshot.id} className={css.row}>
                {confirmRestore === snapshot.id ? (
                  <>
                    <p className={css.danger}>{t('snapRestoreConfirmText')}</p>
                    <div className={css.toolbar}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => { restore(snapshot.id) }}
                      >{pending === 'restore' ? t('snapRestoring') : t('snapRestoreConfirm')}</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => { setConfirmRestore(null) }}
                      >{t('setCancel')}</Button>
                    </div>
                  </>
                ) : confirmDelete === snapshot.id ? (
                  <>
                    <p className={css.danger}>{t('snapDeleteConfirmText')}</p>
                    <div className={css.toolbar}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => { remove(snapshot.id) }}
                      >{pending === 'delete' ? t('snapDeleting') : t('snapDeleteConfirm')}</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => { setConfirmDelete(null) }}
                      >{t('setCancel')}</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={css.sectionHeader}>
                      <span>{t('snapCreatedAt')}: {formatTime(snapshot.createdAt)}</span>
                      <span className={css.muted}>{t('snapId')}: {snapshot.id}</span>
                    </div>
                    {(snapshot.files ?? []).length > 0 ? (
                      <p className={css.muted}>
                        {t('snapFiles')}: {(snapshot.files ?? []).map(file => file.path).join(', ')}
                      </p>
                    ) : null}
                    <div className={css.toolbar}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => { setConfirmDelete(null); setConfirmRestore(snapshot.id) }}
                      >{t('snapRestore')}</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => { setConfirmRestore(null); setConfirmDelete(snapshot.id) }}
                      >{t('snapDelete')}</Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
