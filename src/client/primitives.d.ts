/**
 * Ambient types for @deepseek-ai/dsh-client-ui-primitives — provided at runtime
 * by the host's frozen platform module table. The package is a build-time
 * external (see tsdown.config.ts CLIENT_EXTERNALS), so these declarations are
 * the ONLY compile-time contract the bundle has with the host primitives.
 *
 * Only the members this plugin renders with are declared; keep the
 * signatures in sync with deepseek-harness/packages/client/ui-primitives.
 *
 * Note: the host exposes no `Spinner` primitive (its spinner is the CSS class
 * in Galaxy.module.css, backed by IconLoadingOutline16), so none is declared.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Pill(props: {
    active?: boolean
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Input(props: {
    icon?: ReactNode
    className?: string
  } & InputHTMLAttributes<HTMLInputElement>): ReactElement

  /**
   * `closeLabel` is optional here even though the current host requires it for
   * the default (non-headless) chrome: making it optional keeps a caller that
   * passes `headless` compiling, and the host only reads it when it renders
   * its own close button.
   */
  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    headless?: boolean
  }): ReactElement | null

  export function Toast(props: {
    text: string
    icon?: ReactNode
    anchor?: HTMLElement | null
    /** Full-opacity hold before the fade; the host defaults to 3000ms. */
    holdMs?: number
    onDone: () => void
  }): ReactElement

  /** One primary-menu entry: a row, a separator, or a heading label. */
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
    submenu?: readonly MenuItem[]
  }
  export interface MenuSeparator { type: 'separator'; id: string }
  export interface MenuLabel { type: 'label'; id: string; text: string }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  export function Menu(props: {
    open: boolean
    anchor: ReactNode
    items: readonly MenuEntry[]
    footer?: readonly MenuEntry[]
    selectedId?: string | undefined
    selectedIds?: readonly string[] | undefined
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    closeOnPointerLeave?: boolean
    dense?: boolean
    compact?: boolean
    className?: string
  }): ReactElement

  export interface DisclosureRowProps {
    icon: ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    expandOnRowClick?: boolean | undefined
    previewChevron?: boolean | undefined
    keepContentWhenOpen?: boolean | undefined
    collapsedContent?: ReactNode
    children?: ReactNode
    className?: string | undefined
    rowClassName?: string | undefined
    leadingClassName?: string | undefined
    chevronClassName?: string | undefined
    titleClassName?: string | undefined
  }
  export function DisclosureRow(props: DisclosureRowProps): ReactElement

  export function Tooltip(props: {
    label: string | (() => string)
    side?: 'right' | 'bottom' | 'top'
    delayMs?: number
    disabled?: boolean
    maxWidth?: number
    children: ReactElement
  }): ReactElement

  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
  export function StateDot(props: {
    state: StateDotState
    size?: number | undefined
    className?: string | undefined
  }): ReactElement

  export interface IconProps {
    size?: number
    className?: string
  }

  /* Icons the Galaxy views render with. Declared as a closed set on purpose:
   * an icon that is not listed here is not part of the contract. */
  export function IconChevronDownOutline14(props: IconProps): ReactElement
  export function IconChevronUpOutline14(props: IconProps): ReactElement
  export function IconChevronLeftOutline14(props: IconProps): ReactElement
  export function IconChevronRightOutline14(props: IconProps): ReactElement
  export function IconCheckOutline16(props: IconProps): ReactElement
  export function IconCheckOutline14(props: IconProps): ReactElement
  export function IconCloseOutline16(props: IconProps): ReactElement
  export function IconEllipsisOutline16(props: IconProps): ReactElement
  export function IconPlusOutline16(props: IconProps): ReactElement
  export function IconSearchOutline16(props: IconProps): ReactElement
  export function IconRefreshOutline16(props: IconProps): ReactElement
  export function IconRefreshOutline14(props: IconProps): ReactElement
  export function IconWarningOutline16(props: IconProps): ReactElement
  export function IconQuestionOutline14(props: IconProps): ReactElement
  export function IconSparkle16(props: IconProps): ReactElement
  export function IconCodeOutline16(props: IconProps): ReactElement
  export function IconCordisPluginOutline14(props: IconProps): ReactElement
  export function IconLoadingOutline16(props: IconProps): ReactElement
  export function IconLinkOutline14(props: IconProps): ReactElement
  export function IconLinkOutline16(props: IconProps): ReactElement
  export function IconDownloadOutline16(props: IconProps): ReactElement
  export function IconTrashOutline16(props: IconProps): ReactElement
  export function IconCopyOutline16(props: IconProps): ReactElement
  export function IconEditOutline16(props: IconProps): ReactElement
  export function IconRightUpOutline14(props: IconProps): ReactElement
  export function IconFullscreenOutline16(props: IconProps): ReactElement
  export function IconFolderOpen16(props: IconProps): ReactElement
  export function IconFolderOpenOutline16(props: IconProps): ReactElement
  export function IconLightOutline16(props: IconProps): ReactElement
  export function IconDarkOutline16(props: IconProps): ReactElement
  export function IconFollowsystemOutline16(props: IconProps): ReactElement
  export function IconArchiveOutline20(props: IconProps): ReactElement
  export function IconGlobeOutline14(props: IconProps): ReactElement
  export function IconSettingsOutline14(props: IconProps): ReactElement
  export function IconDatabaseOutline16(props: IconProps): ReactElement
  export function IconClockOutline16(props: IconProps): ReactElement
  export function IconGaugeOutline16(props: IconProps): ReactElement
  export function IconListPenOutline16(props: IconProps): ReactElement
}
