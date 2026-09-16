/**
 * Named compositions.
 *
 * A preset is the community bundle order plus the disabled set, saved under a
 * name. Saving reads the CURRENT composition from `/installed` rather than
 * from a prop: the preset has to describe what the profile contains at the
 * moment the button is pressed, and the parent's copy of the order may be a
 * draft the user is still editing.
 *
 * The name rule (1–40 characters of letters, digits, CJK, space, `_` or `-`)
 * is enforced here AND on the server: here so the user learns it before a
 * round trip, there because the client is not the authority. The server's
 * rejection `reason` is what the panel shows when it refuses.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import type { Translate } from './locales-settings.ts'
import { fetchInstalled, isGalaxyApiError, listPresets, presetAction } from './market-data.ts'
import type { Preset } from './market-data.ts'

/** Inline result of the last mutation. */
interface Notice {
  kind: 'ok' | 'bad'
  text: string
}

/** The change preview of one preset, from `presetAction('preview')`. */
interface Preview {
  name: string
  order: string[]
  disabled: string[]
}

/** Preset name rule: 1–40 characters of letters, digits, CJK, space, `_` or `-`. */
const NAME_PATTERN = /^[\p{L}\p{N}_ -]{1,40}$/u

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

/** A preset's creation time, or its raw value when it will not parse. */
function formatTime(value: number | undefined): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export function PresetPanel(props: {
  t: Translate
  open: boolean
  onClose: () => void
  onChanged?: () => void
}): ReactElement {
  const { t, open, onClose, onChanged } = props
  const [presets, setPresets] = useState<Preset[]>([])
  const [name, setName] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  /** Preset name awaiting the second click of a delete, or null. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const loaded = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await listPresets()
      setPresets(Array.isArray(list) ? list : [])
      loaded.current = true
    } catch (cause) {
      // Retry on the next open: a transient failure must not leave the panel
      // permanently claiming the profile has no presets.
      loaded.current = false
      setNotice({ kind: 'bad', text: `${t('presetListFail')}: ${messageOf(cause, t)}` })
    }
  }, [t])

  useEffect(() => {
    if (!open || loaded.current) return
    void load()
  }, [open, load])

  const save = useCallback((): void => {
    const presetName = name.trim()
    if (presetName === '' || !NAME_PATTERN.test(presetName) || Array.from(presetName).length > 40) {
      setNotice({ kind: 'bad', text: t('presetNameInvalid') })
      return
    }
    if (pending !== null) return
    setPending('save')
    setNotice(null)
    void (async () => {
      try {
        const installed = await fetchInstalled()
        const result = await presetAction('save', {
          name: presetName,
          bundleOrder: Array.isArray(installed.bundles) ? installed.bundles : [],
          disabled: Array.isArray(installed.disabled) ? installed.disabled : [],
        })
        if (result.ok !== true) {
          setNotice({ kind: 'bad', text: `${t('presetSaveFail')}: ${result.reason ?? t('setFail')}` })
          return
        }
        setName('')
        setNotice({ kind: 'ok', text: t('presetSaved') })
        await load()
        onChanged?.()
      } catch (cause) {
        setNotice({ kind: 'bad', text: `${t('presetSaveFail')}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [load, name, onChanged, pending, t])

  const apply = useCallback((presetName: string): void => {
    if (pending !== null) return
    setPending('apply')
    setNotice(null)
    void (async () => {
      try {
        const result = await presetAction('apply', { name: presetName })
        if (result.ok !== true) {
          setNotice({ kind: 'bad', text: `${t('presetApplyFail')}: ${result.reason ?? t('setFail')}` })
          return
        }
        setPreview(null)
        setNotice({ kind: 'ok', text: t('presetApplied') })
        await load()
        onChanged?.()
      } catch (cause) {
        setNotice({ kind: 'bad', text: `${t('presetApplyFail')}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [load, onChanged, pending, t])

  const inspect = useCallback((presetName: string): void => {
    if (preview?.name === presetName) {
      setPreview(null)
      return
    }
    if (pending !== null) return
    setPending('preview')
    setNotice(null)
    void (async () => {
      try {
        const result = await presetAction('preview', { name: presetName })
        if (result.ok !== true) {
          setNotice({ kind: 'bad', text: `${t('presetPreviewFail')}: ${result.reason ?? t('setFail')}` })
          return
        }
        setPreview({
          name: presetName,
          order: Array.isArray(result.order) ? result.order : [],
          disabled: Array.isArray(result.disabled) ? result.disabled : [],
        })
      } catch (cause) {
        setNotice({ kind: 'bad', text: `${t('presetPreviewFail')}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [pending, preview, t])

  const remove = useCallback((presetName: string): void => {
    if (pending !== null) return
    setPending('delete')
    setNotice(null)
    void (async () => {
      try {
        const result = await presetAction('delete', { name: presetName })
        if (result.ok !== true) {
          setNotice({ kind: 'bad', text: `${t('presetDeleteFail')}: ${result.reason ?? t('setFail')}` })
          return
        }
        setConfirmDelete(null)
        if (preview?.name === presetName) setPreview(null)
        setNotice({ kind: 'ok', text: t('presetDeleted') })
        await load()
        onChanged?.()
      } catch (cause) {
        setNotice({ kind: 'bad', text: `${t('presetDeleteFail')}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [load, onChanged, pending, preview, t])

  const busy = pending !== null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('presetTitle')}
      closeLabel={t('setClose')}
      footer={<Button variant="ghost" size="sm" onClick={onClose}>{t('setClose')}</Button>}
    >
      <div className={css.modalBody} data-entry="preset-panel">
        <p className={css.muted}>{t('presetHint')}</p>

        <div className={css.toolbar}>
          <Input
            value={name}
            placeholder={t('presetNamePlaceholder')}
            aria-label={t('presetNameLabel')}
            disabled={busy}
            maxLength={40}
            onChange={event => { setName(event.currentTarget.value) }}
          />
          <Button variant="primary" size="sm" disabled={busy} onClick={save}>
            {pending === 'save' ? t('presetSaving') : t('presetSave')}
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

        {presets.length === 0 ? (
          <div className={css.empty}>{t('presetEmpty')}</div>
        ) : (
          <div className={css.root}>
            {presets.map(preset => (
              <div key={preset.name} className={css.row}>
                <div className={css.sectionHeader}>
                  <span>{preset.name}</span>
                  <span className={css.muted}>{formatTime(preset.createdAt)}</span>
                  <span className={css.badge}>{(preset.bundleOrder ?? []).length}</span>
                </div>
                {confirmDelete === preset.name ? (
                  <>
                    <p className={css.danger}>{t('presetDeleteConfirmText')}</p>
                    <div className={css.toolbar}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => { remove(preset.name) }}
                      >{t('presetDeleteConfirm')}</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => { setConfirmDelete(null) }}
                      >{t('setCancel')}</Button>
                    </div>
                  </>
                ) : (
                  <div className={css.toolbar}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => { apply(preset.name) }}
                    >{t('presetApply')}</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => { inspect(preset.name) }}
                    >{preview?.name === preset.name ? t('presetPreviewHide') : t('presetPreview')}</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => { setConfirmDelete(preset.name) }}
                    >{t('presetDelete')}</Button>
                  </div>
                )}
                {preview?.name === preset.name ? (
                  <div className={css.row}>
                    <div className={css.sectionHeader}>{t('presetPreviewTitle')}</div>
                    {preview.order.length === 0 && preview.disabled.length === 0 ? (
                      <p className={css.muted}>{t('presetPreviewNone')}</p>
                    ) : (
                      <>
                        {preview.order.length > 0 ? (
                          <p className={css.muted}>
                            {t('presetPreviewOrder')}: {preview.order.join(' → ')}
                          </p>
                        ) : null}
                        {preview.disabled.length > 0 ? (
                          <p className={css.muted}>
                            {t('presetPreviewDisabled')}: {preview.disabled.join(', ')}
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
