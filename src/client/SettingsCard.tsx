/**
 * The Plugin Galaxy card on the plugin configuration
 * page (,,
 *
 * ).
 *
 * This card manages the galaxy ITSELF: what to keep, where to keep it, which
 * route and which build to use, and how to get rid of it again. Every
 * mutation is a POST through `market-data.ts` (the only API client), so this
 * file never talks to HTTP directly and never decides a policy the server
 * already owns.
 *
 * Three rules shape the code:
 *
 *  - **No credential outlives its request.** The WebDAV password is read from
 *    an uncontrolled `<input>` ref at submit time and cleared immediately
 *    after; it is never state, never storage, never a log line. The Gist
 *    token lives in component state only (in memory for the session) because
 *    the four Gist actions each need it, and it is masked on screen.
 *  - **One mutation at a time.** The server serialises writes with a lock, so
 *    a single `pending` flag covers every button: a second click cannot
 *    queue a second mutation, and the label says what is happening.
 *  - **Dependent state is re-read, never guessed.** Channel, region, proxy and
 *    restart re-load `/status`; a restore re-loads the profile summary; the
 *    backup row shows the server's own secret-file count instead of a guess.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import type { Translate } from './locales-settings.ts'
import {
  downloadTextFile,
  fetchBackup,
  fetchInstalled,
  fetchStatus,
  setCatalogSource,
  gistAction,
  isGalaxyApiError,
  restoreBackupFile,
  restartHost,
  selfUninstall,
  setChannel,
  setGithubProxy,
  setRegion,
  webdavAction,
  CatalogSourceView,
} from './market-data.ts'

/**
 * Types are derived from the client functions instead of imported by name, so
 * this card cannot drift from the transport module and does not depend on how
 * `market-data.ts` spells the server DTOs.
 */
type Status = Awaited<ReturnType<typeof fetchStatus>>
/** , as `/backup` serves it. */
type Backup = Awaited<ReturnType<typeof fetchBackup>>

/** Release channels of the galaxy itself (.channel). */
const CHANNELS = ['stable', 'beta', 'dev'] as const
type ChannelId = (typeof CHANNELS)[number]

const CHANNEL_LABEL: Record<ChannelId, string> = {
  stable: 'setChannelStable',
  beta: 'setChannelBeta',
  dev: 'setChannelDev',
}

/** Download regions (.region). */
const REGIONS = ['global', 'china'] as const
type RegionId = (typeof REGIONS)[number]

const REGION_LABEL: Record<RegionId, string> = {
  global: 'setRegionGlobal',
  china: 'setRegionChina',
}

/**
 * Optional `/status` fields read defensively: an operator-managed GitHub
 * route and a probe-chosen region are both things a host may or may not
 * report, and a missing field must never hide the row.
 */
interface StatusExtras {
  githubProxyCustom?: string | null
  githubProxyManaged?: boolean
  regionAuto?: boolean
  /** Catalog source facts, written by the status route. */
  catalogUrl?: string
  siteUrl?: string
  envCatalog?: boolean
  envSite?: boolean
  effectiveCatalogUrl?: string
  catalogSource?: 'env' | 'profile' | 'default'
}

/** Inline result of one action. */
interface Notice {
  kind: 'ok' | 'bad'
  text: string
}

/** The sections that own a notice slot. */
type SectionId =
  | 'load'
  | 'backup'
  | 'restore'
  | 'preview'
  | 'webdav'
  | 'gist'
  | 'region'
  | 'proxy'
  | 'channel'
  | 'catalogSource'
  | 'restart'
  | 'remove'

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

/** HTTP status of a failed call, when the failure carried one. */
function statusOf(cause: unknown): number | null {
  return isGalaxyApiError(cause) ? cause.status : null
}

/** Narrow a free-form value to a channel this card can show. */
function asChannel(value: unknown): ChannelId | null {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value) ? (value as ChannelId) : null
}

/** Narrow a free-form value to a region this card can show. */
function asRegion(value: unknown): RegionId | null {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value) ? (value as RegionId) : null
}

/**
 * Accept a parsed file as a backup. Structural only: `/backup` is the
 * authority and validates strictly, this just refuses to send it something
 * that is obviously a different JSON document.
 */
function asBackup(value: unknown): Backup | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as { format?: unknown; files?: unknown }
  if (typeof record.format !== 'string' || !record.format.endsWith('backup')) return null
  if (!Array.isArray(record.files)) return null
  return value as Backup
}

/** A download name that sorts chronologically and cannot contain a path. */
function backupFilename(createdAt: string): string {
  const stamp = createdAt.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '')
  return `dsh-galaxy-backup-${stamp === '' ? String(Date.now()) : stamp}.json`
}

/**
 * Why a proxy prefix is unusable, or null when it is fine. Mirrors the
 * server's rule (HTTPS, no credentials, no query, no fragment) so the user is
 * told before a round trip, not after.
 */
function proxyProblem(value: string): string | null {
  if (value === '') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'invalid'
  }
  if (url.protocol !== 'https:') return 'https'
  if (url.username !== '' || url.password !== '') return 'credentials'
  if (url.search !== '' || url.hash !== '') return 'query'
  return null
}

/** One section title, its explanation and the result of its last action. */
function Section(props: {
  title: string
  hint?: string | undefined
  notice?: Notice | undefined
  children?: ReactNode
}): ReactElement {
  return (
    <section className={css.row}>
      <div className={css.sectionHeader}>{props.title}</div>
      {props.hint !== undefined ? <p className={css.muted}>{props.hint}</p> : null}
      {props.notice !== undefined ? (
        <p className={props.notice.kind === 'bad' ? css.danger : css.muted} role={props.notice.kind === 'bad' ? 'alert' : 'status'}>
          {props.notice.text}
        </p>
      ) : null}
      {props.children}
    </section>
  )
}

/** One labelled text field; the label is the accessible name. */
function Field(props: {
  label: string
  type: 'text' | 'url' | 'password'
  value?: string
  placeholder?: string | undefined
  autoComplete?: string | undefined
  disabled: boolean
  onChange?: (value: string) => void
  inputRef?: { current: HTMLInputElement | null } | undefined
}): ReactElement {
  const { label, type, disabled } = props
  return (
    <label className={css.row}>
      <span className={css.muted}>{label}</span>
      <input
        type={type}
        ref={props.inputRef}
        {...(props.value === undefined ? {} : { value: props.value })}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        aria-label={label}
        disabled={disabled}
        onChange={event => { props.onChange?.(event.currentTarget.value) }}
      />
    </label>
  )
}

export function SettingsCard(props: {
  t: Translate
  onRemoved?: () => void
}): ReactElement {
  const { t, onRemoved } = props
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [summary, setSummary] = useState<{ profile: string; count: number } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [notices, setNotices] = useState<Partial<Record<SectionId, Notice>>>({})
  /** The most recent backup this card saw — downloaded, imported or fetched. */
  const [backup, setBackup] = useState<Backup | null>(null)
  /** A backup retrieved from WebDAV/Gist, awaiting an explicit restore. */
  const [fetched, setFetched] = useState<{ source: string; backup: Backup } | null>(null)
  /** Catalog source: stored values + which layer wins (see the route's comment). */
  const [catalogSource, setCatalogSourceState] = useState<CatalogSourceView | null>(null)
  const [catalogDraft, setCatalogDraft] = useState('')
  const [siteDraft, setSiteDraft] = useState('')
  const [proxyManaged, setProxyManaged] = useState(false)
  const [proxyDraft, setProxyDraft] = useState('')
  const [webdavUrl, setWebdavUrl] = useState('')
  const [webdavUser, setWebdavUser] = useState('')
  /** The Gist token is memory-only: never storage, never a log line. */
  const [gistToken, setGistToken] = useState('')
  const [gistId, setGistId] = useState('')
  const [removeStep, setRemoveStep] = useState<'idle' | 'confirm'>('idle')
  const [purge, setPurge] = useState(false)
  const [removed, setRemoved] = useState(false)
  /** The WebDAV password field is uncontrolled; this is the only handle on it. */
  const passwordRef = useRef<HTMLInputElement | null>(null)
  const probed = useRef(false)

  const busy = pending !== null

  const notice = useCallback((id: SectionId, value: Notice | null): void => {
    setNotices(current => {
      const next = { ...current }
      if (value === null) delete next[id]
      else next[id] = value
      return next
    })
  }, [])

  /** Re-read the profile summary and the host status. */
  const load = useCallback(async (): Promise<void> => {
    try {
      const [installed, next] = await Promise.all([fetchInstalled(), fetchStatus()])
      // The status payload carries the catalog source; no second request.
      const catalog = next as unknown as StatusExtras
      setCatalogSourceState({
        catalogUrl: catalog.catalogUrl ?? '',
        siteUrl: catalog.siteUrl ?? '',
        envCatalog: catalog.envCatalog === true,
        envSite: catalog.envSite === true,
        effectiveCatalogUrl: catalog.effectiveCatalogUrl ?? '',
        catalogSource: catalog.catalogSource ?? 'default',
      })
      setCatalogDraft(current => (current === '' ? (catalog.catalogUrl ?? '') : current))
      setSiteDraft(current => (current === '' ? (catalog.siteUrl ?? '') : current))
      setSummary({ profile: installed.profile, count: (installed.installed ?? []).length })
      setStatus(next)
      const extras = next as unknown as StatusExtras
      setProxyManaged(extras.githubProxyManaged === true)
      setProxyDraft(current => (current === '' ? (extras.githubProxyCustom ?? '') : current))
      notice('load', null)
    } catch (cause) {
      notice('load', { kind: 'bad', text: `${t('setSummaryFail')}: ${messageOf(cause, t)}` })
    }
  }, [notice, t])

  // The card is one row among many on the plugin page; nothing is fetched
  // until the user opens it, and only once per mount.
  useEffect(() => {
    if (!open || probed.current) return
    probed.current = true
    void load()
  }, [open, load])

  /**
   * Run one mutation with a single guard: refusal to start while another is
   * in flight, a cleared notice, the failure prefixed with the section's own
   * sentence, and the pending flag released whatever happens.
   */
  const run = useCallback((id: SectionId, action: string, failKey: string, task: () => Promise<void>): void => {
    if (pending !== null) return
    setPending(action)
    notice(id, null)
    void (async () => {
      try {
        await task()
      } catch (cause) {
        notice(id, { kind: 'bad', text: `${t(failKey)}: ${messageOf(cause, t)}` })
      } finally {
        setPending(null)
      }
    })()
  }, [notice, pending, t])

  /* ---------------------------------------------------------------- *
   * Backup / restore
   * ---------------------------------------------------------------- */

  const onDownloadBackup = (): void => {
    run('backup', 'backup', 'setBackupFail', async () => {
      const next = await fetchBackup()
      setBackup(next)
      downloadTextFile(backupFilename(next.createdAt), JSON.stringify(next, null, 2))
      notice('backup', { kind: 'ok', text: t('setBackupOk') })
    })
  }

  const onRestoreFile = (file: File | null): void => {
    if (file === null) return
    run('restore', 'restore', 'setRestoreFail', async () => {
      let text: string
      try {
        text = await file.text()
      } catch {
        notice('restore', { kind: 'bad', text: t('setRestoreReadFail') })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        notice('restore', { kind: 'bad', text: t('setRestoreBadFile') })
        return
      }
      const candidate = asBackup(parsed)
      if (candidate === null) {
        notice('restore', { kind: 'bad', text: t('setRestoreBadFile') })
        return
      }
      setBackup(candidate)
      const result = await restoreBackupFile(candidate)
      notice('restore', {
        kind: 'ok',
        text: `${t('setRestoreOk')} ${t('setRestoreRestored')}: ${result.restored.length} · ${t('setRestoreSkipped')}: ${result.skipped.length}`,
      })
      await load()
    })
  }

  const onRestoreFetched = (): void => {
    const pendingBackup = fetched
    if (pendingBackup === null) return
    run('preview', 'preview-restore', 'setRestoreFail', async () => {
      const result = await restoreBackupFile(pendingBackup.backup)
      setFetched(null)
      notice('preview', {
        kind: 'ok',
        text: `${t('setRestoreOk')} ${t('setRestoreRestored')}: ${result.restored.length} · ${t('setRestoreSkipped')}: ${result.skipped.length}`,
      })
      await load()
    })
  }

  /* ---------------------------------------------------------------- *
   * WebDAV
   * ---------------------------------------------------------------- */

  /**
   * Save the catalog source, then tell the panel to reload.
   *
   * The panel and this card are separate subtrees of the same bundle, and the
   * panel holds the registry it already fetched: without the event it would keep
   * showing the previous catalog until the user happened to press refresh.
   */
  const onCatalogSource = useCallback((clear: boolean): void => {
    void run('catalogSource', 'catalogSource', 'setCatalogFail', async () => {
      const next = await setCatalogSource(clear
        ? { catalogUrl: '', siteUrl: '' }
        : { catalogUrl: catalogDraft.trim(), siteUrl: siteDraft.trim() })
      setCatalogSourceState(next)
      if (clear) {
        setCatalogDraft('')
        setSiteDraft('')
      }
      window.dispatchEvent(new CustomEvent('dsh-galaxy:catalog-source-changed'))
      notice('catalogSource', {
        kind: 'ok',
        text: `${t('setCatalogOk')} ${t('setCatalogEffective', {
          url: next.effectiveCatalogUrl,
          source: t(next.catalogSource === 'env' ? 'setCatalogSourceEnv' : next.catalogSource === 'profile' ? 'setCatalogSourceProfile' : 'setCatalogSourceDefault'),
        })}`,
      })
    })
  }, [catalogDraft, siteDraft, notice, run, t])

  /**
   * Read the password out of the DOM and wipe the field in the same turn: the
   * value exists for the length of one request and nowhere else.
   */
  const takePassword = (): string => {
    const field = passwordRef.current
    const value = field === null ? '' : field.value
    if (field !== null) field.value = ''
    return value
  }

  const onWebdav = (action: 'upload' | 'download'): void => {
    const url = webdavUrl.trim()
    if (url === '') {
      notice('webdav', { kind: 'bad', text: t('setWebdavNeedUrl') })
      return
    }
    const username = webdavUser.trim()
    const password = takePassword()
    run('webdav', `webdav-${action}`, 'setWebdavFail', async () => {
      const result = await webdavAction(action, {
        url,
        ...(username === '' ? {} : { username }),
        ...(password === '' ? {} : { password }),
      })
      if (result.ok !== true) {
        notice('webdav', { kind: 'bad', text: result.error ?? t('setWebdavFail') })
        return
      }
      if (action === 'upload') {
        notice('webdav', { kind: 'ok', text: t('setWebdavUploadOk') })
        return
      }
      // A download is a preview, never a blind overwrite: the server's own
      // rule is download → review → /restore.
      const candidate = asBackup((result as unknown as { backup?: unknown }).backup)
      if (candidate !== null) setFetched({ source: t('setWebdavTitle'), backup: candidate })
      notice('webdav', { kind: 'ok', text: t('setWebdavDownloadOk') })
    })
  }

  /* ---------------------------------------------------------------- *
   * Gist
   * ---------------------------------------------------------------- */

  const onGist = (action: 'create' | 'update' | 'read' | 'verify'): void => {
    const token = gistToken.trim()
    const id = gistId.trim()
    const needsId = action === 'update' || action === 'read'
    if (token === '') {
      notice('gist', { kind: 'bad', text: t('setGistNeedToken') })
      return
    }
    if (needsId && id === '') {
      notice('gist', { kind: 'bad', text: t('setGistNeedId') })
      return
    }
    run('gist', `gist-${action}`, 'setGistFail', async () => {
      const result = await gistAction(action, {
        token,
        ...(needsId ? { gistId: id } : {}),
      })
      if (result.ok !== true) {
        notice('gist', { kind: 'bad', text: result.error ?? t('setGistFail') })
        return
      }
      if (typeof result.gistId === 'string' && result.gistId !== '') setGistId(result.gistId)
      if (action === 'verify') {
        notice('gist', { kind: 'ok', text: t('setGistVerifyOk') })
        return
      }
      if (action === 'create') {
        notice('gist', { kind: 'ok', text: t('setGistCreated') })
        return
      }
      if (action === 'update') {
        notice('gist', { kind: 'ok', text: t('setGistUpdated') })
        return
      }
      // `read` may carry the backup back; when it does, it becomes a preview
      // the user restores explicitly, exactly like a WebDAV download.
      const candidate = asBackup((result as unknown as { backup?: unknown }).backup)
      if (candidate !== null) setFetched({ source: t('setGistTitle'), backup: candidate })
      notice('gist', { kind: 'ok', text: t('setGistReadOk') })
    })
  }

  /* ---------------------------------------------------------------- *
   * Network route and channel
   * ---------------------------------------------------------------- */

  const onRegion = (next: RegionId): void => {
    run('region', `region-${next}`, 'setRegionFail', async () => {
      await setRegion(next)
      await load()
      notice('region', { kind: 'ok', text: t('setRegionOk') })
    })
  }

  const onProxy = (value: string | null): void => {
    const next = value === null ? '' : value.trim()
    const problem = proxyProblem(next)
    if (problem !== null) {
      notice('proxy', { kind: 'bad', text: t('setProxyInvalid') })
      return
    }
    run('proxy', 'proxy', 'setProxyFail', async () => {
      try {
        await setGithubProxy(next)
      } catch (cause) {
        // 409 is the operator's environment owning the route; that is a state
        // to show, not an error to retry.
        if (statusOf(cause) === 409) {
          setProxyManaged(true)
          notice('proxy', { kind: 'bad', text: t('setProxyManaged') })
          return
        }
        throw cause
      }
      await load()
      notice('proxy', { kind: 'ok', text: next === '' ? t('setProxyCleared') : t('setProxyOk') })
    })
  }

  const onChannel = (next: ChannelId): void => {
    run('channel', `channel-${next}`, 'setChannelFail', async () => {
      await setChannel(next)
      await load()
      notice('channel', { kind: 'ok', text: t('setChannelOk') })
    })
  }

  /* ---------------------------------------------------------------- *
   * Restart and self-uninstall
   * ---------------------------------------------------------------- */

  const onRestart = (): void => {
    run('restart', 'restart', 'setRestartFail', async () => {
      const schedule = await restartHost()
      if (schedule.scheduled !== true) {
        notice('restart', { kind: 'bad', text: schedule.reason ?? t('setRestartFail') })
        return
      }
      await load()
      notice('restart', { kind: 'ok', text: t('setRestartOk') })
    })
  }

  const onRemove = (): void => {
    run('remove', 'remove', 'setRemoveFail', async () => {
      const result = await selfUninstall(true, purge) as unknown as { ok?: unknown; error?: unknown; reason?: unknown }
      if (result.ok === false) {
        const detail = typeof result.error === 'string' && result.error !== ''
          ? result.error
          : typeof result.reason === 'string' && result.reason !== '' ? result.reason : t('setRemoveFail')
        notice('remove', { kind: 'bad', text: detail })
        return
      }
      setRemoved(true)
      onRemoved?.()
    })
  }

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const extras = (status ?? {}) as unknown as StatusExtras
  const version = status === null ? null : status.version
  const currentChannel = asChannel(status === null ? null : status.channel) ?? 'stable'
  const currentRegion = asRegion(status === null ? null : status.region) ?? 'global'
  const restartAllowed = status?.restart?.allowed === true
  const restartReason = status?.restart?.reason
  const secretCount = backup?.secretFileCount ?? 0
  const fetchedSecretCount = fetched?.backup.secretFileCount ?? 0

  return (
    <div className={css.card} data-entry="settings-card">
      <button
        type="button"
        className={css.sectionHeader}
        aria-expanded={open}
        aria-label={t(open ? 'setCollapse' : 'setExpand')}
        onClick={() => { setOpen(current => !current) }}
      >
        <span>{t('setTitle')}</span>
        {version !== null ? <span className={css.badge}>{`v${version}`}</span> : null}
        {currentChannel !== 'stable' ? <span className={css.badge}>{t(CHANNEL_LABEL[currentChannel])}</span> : null}
        <span className={css.muted}>{t('setDesc')}</span>
      </button>

      {open ? (
        <div className={css.root}>
          <Section title={t('setProfile')} notice={notices.load}>
            <div className={css.toolbar}>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => { void load() }}
              >{t('setRefresh')}</Button>
            </div>
            <div className={css.row}>
              <span className={css.muted}>{t('setVersion')}: {version ?? '—'}</span>
              <span className={css.muted}>{t('setProfile')}: {summary?.profile ?? '—'}</span>
              <span className={css.muted}>{t('setInstalledCount')}: {summary?.count ?? '—'}</span>
            </div>
          </Section>

          <Section title={t('setBackupTitle')} hint={t('setBackupHint')} notice={notices.backup}>
            <div className={css.toolbar}>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onDownloadBackup}
              >{pending === 'backup' ? t('setBackupPreparing') : t('setBackupDownload')}</Button>
              {backup !== null ? (
                <span className={css.muted}>{t('setBackupMeta')}: {(backup.files ?? []).length}</span>
              ) : null}
            </div>
            {secretCount > 0 ? (
              <p className={css.danger}>{t('setBackupSecret', { count: secretCount })}</p>
            ) : null}
          </Section>

          <Section title={t('setRestoreTitle')} hint={t('setRestoreHint')} notice={notices.restore}>
            <input
              type="file"
              accept=".json,application/json"
              aria-label={t('setRestoreChoose')}
              disabled={busy}
              onChange={event => {
                const input = event.currentTarget
                const file = input.files?.[0] ?? null
                // Clear the control so choosing the same file twice still fires.
                input.value = ''
                onRestoreFile(file)
              }}
            />
            {pending === 'restore' ? <p className={css.muted}>{t('setRestoreWorking')}</p> : null}
          </Section>

          {fetched !== null ? (
            <Section title={t('setPreviewTitle')} notice={notices.preview}>
              <p className={css.muted}>{t('setPreviewSource')}: {fetched.source}</p>
              <p className={css.muted}>{t('setPreviewCreatedAt')}: {fetched.backup.createdAt}</p>
              <p className={css.muted}>{t('setBackupMeta')}: {(fetched.backup.files ?? []).length}</p>
              {fetchedSecretCount > 0 ? (
                <p className={css.danger}>{t('setPreviewSecret', { count: fetchedSecretCount })}</p>
              ) : null}
              <div className={css.toolbar}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={onRestoreFetched}
                >{t('setPreviewRestore')}</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => { setFetched(null) }}
                >{t('setPreviewDiscard')}</Button>
              </div>
            </Section>
          ) : null}

          <Section title={t('setWebdavTitle')} hint={t('setWebdavHint')} notice={notices.webdav}>
            <Field
              label={t('setWebdavUrl')}
              type="url"
              value={webdavUrl}
              placeholder={t('setWebdavUrlPlaceholder')}
              disabled={busy}
              onChange={setWebdavUrl}
            />
            <Field
              label={t('setWebdavUser')}
              type="text"
              value={webdavUser}
              autoComplete="username"
              disabled={busy}
              onChange={setWebdavUser}
            />
            <Field
              label={t('setWebdavPassword')}
              type="password"
              autoComplete="current-password"
              disabled={busy}
              inputRef={passwordRef}
            />
            <div className={css.toolbar}>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => { onWebdav('upload') }}
              >{pending === 'webdav-upload' ? t('setWebdavUploading') : t('setWebdavUpload')}</Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => { onWebdav('download') }}
              >{pending === 'webdav-download' ? t('setWebdavDownloading') : t('setWebdavDownload')}</Button>
            </div>
          </Section>

          <Section title={t('setGistTitle')} hint={t('setGistHint')} notice={notices.gist}>
            <p className={css.muted}>{t('setGistScopeNote')}</p>
            <Field
              label={t('setGistToken')}
              type="password"
              value={gistToken}
              placeholder={t('setGistTokenPlaceholder')}
              autoComplete="off"
              disabled={busy}
              onChange={setGistToken}
            />
            <Field
              label={t('setGistId')}
              type="text"
              value={gistId}
              placeholder={t('setGistIdPlaceholder')}
              disabled={busy}
              onChange={setGistId}
            />
            <div className={css.toolbar}>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { onGist('create') }}>
                {pending === 'gist-create' ? t('setGistWorking') : t('setGistCreate')}
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { onGist('update') }}>
                {pending === 'gist-update' ? t('setGistWorking') : t('setGistUpdate')}
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { onGist('read') }}>
                {pending === 'gist-read' ? t('setGistWorking') : t('setGistRead')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { onGist('verify') }}>
                {pending === 'gist-verify' ? t('setGistWorking') : t('setGistVerify')}
              </Button>
            </div>
          </Section>

          <Section
            title={t('setRegionTitle')}
            hint={proxyManaged ? t('setRegionManaged') : extras.regionAuto === true ? t('setRegionAuto') : t('setRegionHint')}
            notice={notices.region}
          >
            <div className={css.toolbar}>
              {REGIONS.map(id => (
                <Button
                  key={id}
                  variant={id === currentRegion ? 'primary' : 'ghost'}
                  size="sm"
                  disabled={busy || status === null || proxyManaged}
                  onClick={() => { onRegion(id) }}
                >{t(REGION_LABEL[id])}</Button>
              ))}
            </div>
          </Section>

          <Section
            title={t('setCatalogTitle')}
            hint={catalogSource !== null && (catalogSource.envCatalog || catalogSource.envSite)
              ? t('setCatalogEnv', { name: catalogSource.envCatalog ? 'DSHG_REGISTRY_URL' : 'DSHG_SITE_URL' })
              : t('setCatalogHint')}
            notice={notices.catalogSource}
          >
            <Field
              label={t('setCatalogUrlLabel')}
              type="url"
              value={catalogDraft}
              placeholder={t('setCatalogUrlPlaceholder')}
              disabled={busy}
              onChange={setCatalogDraft}
            />
            <Field
              label={t('setSiteUrlLabel')}
              type="url"
              value={siteDraft}
              placeholder={t('setSiteUrlPlaceholder')}
              disabled={busy}
              onChange={setSiteDraft}
            />
            <div className={css.toolbar}>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => { onCatalogSource(false) }}
              >{pending === 'catalogSource' ? t('setCatalogSaving') : t('setCatalogSave')}</Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => { onCatalogSource(true) }}
              >{t('setCatalogClear')}</Button>
            </div>
            {catalogSource !== null ? (
              <p className={css.muted}>
                {t('setCatalogEffective', {
                  url: catalogSource.effectiveCatalogUrl,
                  source: t(catalogSource.catalogSource === 'env'
                    ? 'setCatalogSourceEnv'
                    : catalogSource.catalogSource === 'profile' ? 'setCatalogSourceProfile' : 'setCatalogSourceDefault'),
                })}
              </p>
            ) : null}
          </Section>

          <Section
            title={t('setProxyTitle')}
            hint={proxyManaged ? t('setProxyManaged') : t('setProxyHint')}
            notice={notices.proxy}
          >
            {proxyManaged ? null : (
              <>
                <Field
                  label={t('setProxyTitle')}
                  type="url"
                  value={proxyDraft}
                  placeholder={t('setProxyPlaceholder')}
                  disabled={busy}
                  onChange={setProxyDraft}
                />
                <div className={css.toolbar}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || proxyDraft.trim() === ''}
                    onClick={() => { onProxy(proxyDraft) }}
                  >{pending === 'proxy' ? t('setProxySaving') : t('setProxySave')}</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => { onProxy(null) }}
                  >{t('setProxyClear')}</Button>
                </div>
              </>
            )}
          </Section>

          <Section title={t('setChannelTitle')} hint={t('setChannelHint')} notice={notices.channel}>
            <div className={css.toolbar}>
              {CHANNELS.map(id => (
                <Button
                  key={id}
                  variant={id === currentChannel ? 'primary' : 'ghost'}
                  size="sm"
                  disabled={busy || status === null}
                  onClick={() => { onChannel(id) }}
                >{t(CHANNEL_LABEL[id])}</Button>
              ))}
            </div>
          </Section>

          <Section
            title={t('setRestartTitle')}
            hint={restartAllowed
              ? t('setRestartHint')
              : `${t('setRestartBlocked')}${restartReason === undefined ? '' : `: ${restartReason}`}`}
            notice={notices.restart}
          >
            <div className={css.toolbar}>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !restartAllowed}
                onClick={onRestart}
              >{pending === 'restart' ? t('setRestartWorking') : t('setRestartAction')}</Button>
            </div>
          </Section>

          <Section title={t('setRemoveTitle')} hint={t('setRemoveHint')} notice={notices.remove}>
            {removed ? (
              <p className={css.muted}>{t('setRemoveOk')} {t('setRemoveOkHint')}</p>
            ) : removeStep === 'confirm' ? (
              <>
                <p className={css.danger}>{t('setRemoveConfirmText')}</p>
                <label className={css.row}>
                  <input
                    type="checkbox"
                    checked={purge}
                    disabled={busy}
                    onChange={() => { setPurge(current => !current) }}
                  />
                  <span>{t('setRemovePurge')}</span>
                </label>
                {/* States the consequence of the CURRENT choice, both ways:
                    what "keeping" costs is the part a user cannot work out. */}
                <p className={css.muted}>{purge ? t('setRemovePurgeOn') : t('setRemovePurgeOff')}</p>
                <div className={css.toolbar}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => { setRemoveStep('idle'); setPurge(false) }}
                  >{t('setCancel')}</Button>
                  <Button
                    variant="primary"
                    size="sm"
                    className={css.danger}
                    disabled={busy}
                    onClick={onRemove}
                  >{pending === 'remove' ? t('setRemoveWorking') : t('setRemoveConfirm')}</Button>
                </div>
              </>
            ) : (
              <div className={css.toolbar}>
                <Button
                  variant="outline"
                  size="sm"
                  className={css.danger}
                  disabled={busy}
                  onClick={() => { setRemoveStep('confirm') }}
                >{t('setRemoveAction')}</Button>
              </div>
            )}
          </Section>
        </div>
      ) : null}
    </div>
  )
}
