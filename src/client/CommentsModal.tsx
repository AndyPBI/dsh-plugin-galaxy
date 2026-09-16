/**
 * Catalog comment thread for one plugin.
 *
 * The curated catalog ships its comments inside the registry entry, so opening
 * this dialog is a pure local read: no third-party request, no module-level
 * state, and the plugin's own catalog data is the only source the reader sees.
 * Parsing lives in comments.ts; this file renders what it returns.
 */

import { useMemo } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Galaxy.module.css'
import { parseComments } from './comments.ts'
import type { RegistryPlugin, Translate } from './market-data.ts'

/**
 * Render the comment thread of one catalog entry.
 * @param props.t - translator bound to this plugin's namespace.
 * @param props.open - whether the dialog is showing.
 * @param props.plugin - the entry whose comments to show; `null` renders empty.
 * @param props.onClose - Escape, mask click, or the close action.
 */
export function CommentsModal(props: {
  t: Translate
  open: boolean
  plugin: RegistryPlugin | null
  onClose: () => void
}) {
  const { t, open, plugin, onClose } = props
  const comments = useMemo(() => parseComments(plugin?.comments ?? ''), [plugin])
  const title = plugin === null
    ? t('commentsTitle')
    : `${t('commentsTitle')} — ${plugin.name}`

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('commentsClose')}
      footer={(
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('commentsClose')}
        </Button>
      )}
    >
      <div className={css.modalBody} data-entry="comments">
        <p className={css.hint}>{t('commentsNote')}</p>
        {comments.length === 0
          ? (
              <div className={css.empty}>
                <div className={css.emptyTitle}>{t('commentsEmpty')}</div>
              </div>
            )
          : (
              <div className={css.list} role="list">
                {comments.map((comment, index) => (
                  <div
                    key={`${comment.author ?? 'anon'}-${String(index)}`}
                    role="listitem"
                    className={css.card}
                  >
                    <div className={css.cardHead}>
                      <span className={css.badge}>
                        {comment.author ?? t('commentsTitle')}
                      </span>
                    </div>
                    <p className={css.cardDesc}>{comment.body}</p>
                  </div>
                ))}
              </div>
            )}
      </div>
    </Modal>
  )
}
