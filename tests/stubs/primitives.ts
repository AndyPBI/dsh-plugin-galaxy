/**
 * Test stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The real module is host-injected at runtime (external in the client bundle and
 * not an npm dependency of this package), so source-level component tests cannot
 * resolve it. `vitest.config.ts` aliases the specifier here.
 *
 * The stubs render semantic DOM with props forwarded: these tests assert the
 * plugin's own structure and wiring, not the primitives' visuals.
 */

import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'

interface ButtonLikeProps {
  variant?: string
  size?: string
  icon?: ReactNode
  className?: string
  children?: ReactNode
  [key: string]: unknown
}

/** A real `<button>` so click handlers behave like the host's. */
export function Button({ variant: _variant, size: _size, icon: _icon, ...rest }: ButtonLikeProps): ReactElement {
  return createElement('button', { type: 'button', ...rest })
}

export function Input(props: Record<string, unknown>): ReactElement {
  return createElement('input', props)
}

/**
 * Renders a real `role="dialog"` container, and — like the host's Modal —
 * renders NOTHING while closed and renders the `footer` slot (the confirm /
 * cancel buttons live there). Ignoring either one makes a test query for "the
 * dialog's confirm button" silently find nothing.
 */
export function Modal({
  children,
  footer,
  open,
  onClose: _onClose,
  title: _title,
  closeLabel: _closeLabel,
  ...rest
}: {
  children?: ReactNode
  footer?: ReactNode
  open?: boolean
} & Record<string, unknown>): ReactElement | null {
  if (open === false) return null
  return createElement('div', { role: 'dialog', ...rest }, children, footer ?? null)
}

export function Toast(props: { text?: string } & Record<string, unknown>): ReactElement {
  return createElement('div', { role: 'status', ...props }, props.text ?? null)
}

export function Pill({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>): ReactElement {
  return createElement('span', rest, children)
}

export function Tag({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>): ReactElement {
  return createElement('span', rest, children)
}

export function Switch(props: Record<string, unknown>): ReactElement {
  return createElement('input', { type: 'checkbox', ...props })
}

export function Menu({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>): ReactElement {
  return createElement('div', { role: 'menu', ...rest }, children)
}

export function DisclosureRow({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>): ReactElement {
  return createElement('div', rest, children)
}

export function Tooltip({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>): ReactElement {
  return createElement('span', rest, children)
}

export function StateDot(props: Record<string, unknown>): ReactElement {
  return createElement('span', props)
}

/* Icons: the bundle dereferences three of them, through the RUNTIME resolver in
 * src/client/icons.ts. The stub ships the 0.2.x spelling (what the current host
 * provides), so component tests exercise the new-name branch; the old-spelling
 * fallback and the "neither exists" case are covered by the pure resolver test. */
const icon = (name: string) => (props: Record<string, unknown>): ReactElement =>
  createElement('svg', { 'data-icon': name, ...props })

export const IconRefreshOutlineRegular = icon('IconRefreshOutlineRegular')
export const IconSearchOutlineRegular = icon('IconSearchOutlineRegular')
export const IconSparkleRegular = icon('IconSparkleRegular')
