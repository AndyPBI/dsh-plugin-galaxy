/**
 * Catalog comment parsing.
 *
 * The curated catalog carries one free-form `comments` string per entry. This
 * module turns that blob into structured comments — no network access, no
 * module-level state — so the comments dialog (CommentsModal.tsx) can render
 * authors and bodies without knowing anything about the source format.
 *
 * Accepted shapes, all separated by blank lines:
 *
 *     @alice: The notification hooks are excellent.
 *     author: bob
 *     Works with the terminal plugin too.
 *     张三：中文条目里作者写在冒号前面。
 *
 * Markdown link syntax is flattened to plain text so a catalog link cannot
 * inject markup into the dialog, and each body is capped at MAX_BODY characters
 * to keep one pasted essay from dominating the modal.
 */

/** One parsed catalog comment. `author` is absent when the block has no marker. */
export interface ParsedComment {
  author?: string
  body: string
}

/** Longest body kept verbatim; anything beyond is ellipsized. */
export const MAX_COMMENT_BODY = 600

/** Markers recognised at the start of a block: `@name` or `author: name`. */
const AUTHOR_LABEL = /^(?:author|by|作者|评论者)\s*[:：]\s*(\S[^\n]*)/i

/**
 * Flatten markdown-ish inline syntax to plain text.
 *
 * Only the constructs a catalog blurb plausibly contains are handled: images
 * and links keep their label, autolinks and inline code keep their target,
 * emphasis markers are dropped. Line structure is preserved (the dialog shows
 * it), but runs of blank lines collapse.
 * @param text - raw comment block.
 * @returns plain text, trimmed.
 */
function stripMarkdown(text: string): string {
  return text
    // ![alt](url) → alt, [label](url) → label
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
    // <https://…> and <mailto:…> autolinks
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
    // `code`, ``code``, ```code```
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    // **bold** / __bold__ / *em* / _em_
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
    // leading blockquote / heading markers, and any stray backslash escapes
    .replace(/^[ \t]*(?:>[ \t]*|#{1,6}[ \t]*)+/gm, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * True when a line itself opens a new comment.
 *
 * A catalog occasionally writes two comments back to back with a single
 * newline. Without this check the first marker would swallow the second
 * comment as its body, so a marker-only opening line followed by another
 * marker is treated as an unmarked block instead.
 */
function startsWithMarker(line: string): boolean {
  return line.startsWith('@') || AUTHOR_LABEL.test(line)
}

/** Cap a body, marking the cut so a truncated comment is not read as complete. */
function capped(body: string): string {
  return body.length <= MAX_COMMENT_BODY ? body : `${body.slice(0, MAX_COMMENT_BODY).trimEnd()}…`
}

/**
 * Parse a catalog `comments` field into structured comments.
 * @param text - the free-form catalog value (`undefined`/empty yields `[]`).
 * @returns one entry per non-empty block, in catalog order.
 */
export function parseComments(text: string): ParsedComment[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/)
  const out: ParsedComment[] = []
  for (const block of blocks) {
    const trimmed = block.trim()
    if (trimmed === '') continue
    let author: string | undefined
    let rest = trimmed
    if (rest.startsWith('@')) {
      // `@handle`, `@handle:`, `@handle：`, or `@handle ` followed by the body.
      const match = /^@([^\s:：@]+)[ \t]*[:：]?[ \t]*([^\n]*)(?:\n([\s\S]*))?$/.exec(rest)
      if (match !== null) {
        const inlineBody = (match[2] ?? '').trim()
        const tail = (match[3] ?? '').trim()
        const bodyText = inlineBody === '' ? tail : tail === '' ? inlineBody : `${inlineBody}\n${tail}`
        if (bodyText !== '' && !(inlineBody === '' && startsWithMarker(tail))) {
          author = match[1]
          rest = bodyText
        }
      }
    } else {
      const match = AUTHOR_LABEL.exec(rest)
      if (match !== null && match[1]!.trim() !== '') {
        const lines = rest.split('\n')
        const head = match[1]!.trim()
        const remainder = lines.slice(1).join('\n').trim()
        if (remainder !== '' && !startsWithMarker(remainder)) {
          author = head
          rest = remainder
        }
      }
    }
    const body = capped(stripMarkdown(rest))
    if (body === '') continue
    out.push(author === undefined ? { body } : { author, body })
  }
  return out
}

/**
 * How many comments a catalog `comments` field contains.
 * @param text - the free-form catalog value.
 * @returns the number of non-empty blocks; always agrees with `parseComments`.
 */
export function commentCount(text: string): number {
  return parseComments(text).length
}
