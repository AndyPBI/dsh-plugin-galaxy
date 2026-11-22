/**
 * The card's 简介 dialog.
 *
 * The prose lives on the operator's website, not in the plugin catalog: the
 * dialog asks the plugin's own server (`/dsh-galaxy/intro`) for the row's
 * `owner/name` key, and the server reads the site's catalog (cached) so the
 * browser never makes a cross-origin call. The full site intro is preferred
 * over the short card line; an empty or unreachable site degrades to a message
 * with the site link rather than a blank modal.
 */

import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import { fetchIntro } from './market-data.ts'
import type { RegistryPlugin, SiteIntro, Translate } from './market-data.ts'

type IntroState =
  | { status: 'loading' }
  | { status: 'ready'; intro: SiteIntro }
  | { status: 'error' }

/** The site's host, for the "内容来自官网 …" line. */
function siteHost(plugin: RegistryPlugin | null): string | undefined {
  if (plugin?.siteUrl === undefined) return undefined
  try {
    return new URL(plugin.siteUrl).host
  } catch {
    return undefined
  }
}

/** Pick the prose for the active language, falling back to whatever exists. */
function introText(intro: SiteIntro, english: boolean): string | undefined {
  if (english) return intro.descriptionEn ?? intro.descriptionFull ?? intro.description
  return intro.descriptionFull ?? intro.description
}

export function IntroModal(props: {
  t: Translate
  open: boolean
  plugin: RegistryPlugin | null
  /** Whether the app is in English (selects `descEn` when the site ships one). */
  english?: boolean
  onClose: () => void
}) {
  const { t, open, plugin, english, onClose } = props
  const [state, setState] = useState<IntroState>({ status: 'loading' })

  useEffect(() => {
    if (!open || plugin === null) {
      setState({ status: 'loading' })
      return
    }
    let cancelled = false
    const key = plugin.key ?? (plugin.owner !== undefined && plugin.owner !== ''
      ? `${plugin.owner}/${plugin.name}`
      : undefined)
    setState({ status: 'loading' })
    fetchIntro({
      ...(key === undefined ? {} : { key }),
      name: plugin.name,
    }).then(
      (intro) => { if (!cancelled) setState({ status: 'ready', intro }) },
      () => { if (!cancelled) setState({ status: 'error' }) },
    )
    return () => { cancelled = true }
  }, [open, plugin])

  const label = plugin?.displayName ?? plugin?.name ?? ''
  const title = plugin === null ? t('introTitle') : `${t('introTitle')} — ${label}`
  const host = siteHost(plugin)
  const source = host === undefined ? t('introSourceNoSite') : t('introSource', { site: host })
  const text = state.status === 'ready' ? introText(state.intro, english === true) : undefined

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('introClose')}
      className={css.introModal}
      footer={(
        <>
          {plugin?.siteUrl !== undefined && (
            <a
              className={`${css.link} ${css.actionLink}`}
              href={plugin.siteUrl}
              target="_blank"
              rel="noreferrer noopener"
              title={t('siteOpenHint')}
            >
              {t('introSiteOpen')}
            </a>
          )}
          <span className={css.spacer} />
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('introClose')}
          </Button>
        </>
      )}
    >
      <div className={css.modalBody} data-entry="intro">
        <p className={css.hint}>{source}</p>
        {state.status === 'loading' && (
          <div className={css.introLoading} role="status">
            <span className={css.spinner} aria-hidden="true" />
            {t('introLoading')}
          </div>
        )}
        {state.status === 'error' && (
          <div className={css.introError}>{t('introError')}</div>
        )}
        {state.status === 'ready' && (text === undefined || text === '')
          ? (
              <div className={css.introEmpty}>{t('introEmpty')}</div>
            )
          : null}
        {state.status === 'ready' && text !== undefined && text !== '' && (
          <p className={css.introText}>{text}</p>
        )}
      </div>
    </Modal>
  )
}
