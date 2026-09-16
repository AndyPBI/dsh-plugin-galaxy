/**
 * zh/en dictionaries for the Plugin Galaxy settings section and install toast.
 *
 * The dictionary is aggregated from three fragments so that parallel authors
 * never touch the same file: the shared vocabulary below, the market views
 * (`locales-market.ts`) and the settings card (`locales-settings.ts`). The
 * shared vocabulary is spread LAST so the keys every view relies on keep one
 * canonical wording in both languages.
 */

import { marketEn, marketZh } from './locales-market.ts'
import { settingsEn, settingsZh } from './locales-settings.ts'

/** Locale namespace of this plugin: the settings section and card key. */
export const NS = 'dsh-plugin-galaxy'

/** Flat locale dictionary: key -> text. */
export type Dict = Record<string, string>

/** Translate one key, interpolating `{name}` placeholders from `params`. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Keys every view may use, regardless of which fragment owns its own copy. */
export const commonZh: Dict = {
  nav: '插件星系',
  tabDiscover: '发现',
  tabInstalled: '已安装',
  tabFavorites: '收藏',
  tabThemes: '主题',
  loading: '加载中…',
  retry: '重试',
  cancel: '取消',
  save: '保存',
  close: '关闭',
  search: '搜索',
  empty: '暂无内容',
  error: '出错了',
  crashTitle: '插件星系界面崩溃了',
  crashHint: '界面已替换为这个恢复面板，你的插件与 profile 配置未受影响。可以导出日志用于反馈问题。',
  crashReload: '重新加载页面',
  crashDetails: '错误详情',
  exportLog: '导出日志',
  install: '安装',
  installing: '安装中…',
  installed: '已安装',
  update: '更新',
  updating: '更新中…',
  uninstall: '卸载',
  upToDate: '已是最新版本',
  restartRequired: '重启 DeepSeek Harness 后生效',
  favorites: '收藏',
  themes: '主题',
  operations: '操作',
  diagnostics: '诊断',
  snapshots: '快照',
  presets: '预设',
  failed: '失败',
  done: '完成',
  busy: '处理中…',
}

export const commonEn: Dict = {
  nav: 'Plugin Galaxy',
  tabDiscover: 'Discover',
  tabInstalled: 'Installed',
  tabFavorites: 'Favorites',
  tabThemes: 'Themes',
  loading: 'Loading…',
  retry: 'Retry',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  search: 'Search',
  empty: 'Nothing here yet',
  error: 'Something went wrong',
  crashTitle: 'The Plugin Galaxy UI crashed',
  crashHint: 'This recovery panel replaced the view; your plugins and profile configuration are untouched. Export the log to help report the problem.',
  crashReload: 'Reload page',
  crashDetails: 'Error details',
  exportLog: 'Export log',
  install: 'Install',
  installing: 'Installing…',
  installed: 'Installed',
  update: 'Update',
  updating: 'Updating…',
  uninstall: 'Uninstall',
  upToDate: 'Up to date',
  restartRequired: 'Restart DeepSeek Harness to apply',
  favorites: 'Favorites',
  themes: 'Themes',
  operations: 'Operations',
  diagnostics: 'Diagnostics',
  snapshots: 'Snapshots',
  presets: 'Presets',
  failed: 'Failed',
  done: 'Done',
  busy: 'Working…',
}

/** `{name}` placeholder, the only interpolation syntax the dictionaries use. */
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

/**
 * Resolve one key against a dictionary, interpolating `{name}` placeholders.
 * A missing key resolves to the key itself rather than an empty string, so a
 * gap is visible in the UI instead of silently collapsing the layout.
 */
export function translate(dict: Dict, key: string, params?: Record<string, string | number>): string {
  const template = dict[key] ?? key
  if (params === undefined) return template
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Flatten layers (later wins), then fill any key the primary layers missed
 * from the counterpart language. `zh` and `en` therefore always expose the
 * same key set even while the three fragments are maintained by hand: a key
 * that is accidentally added to only one fragment still renders as a real
 * sentence in the other locale instead of a raw identifier.
 */
function merge(primary: readonly Dict[], fallback: readonly Dict[]): Dict {
  const out: Dict = {}
  for (const layer of primary) {
    for (const [key, value] of Object.entries(layer)) out[key] = value
  }
  for (const layer of fallback) {
    for (const [key, value] of Object.entries(layer)) {
      if (out[key] === undefined) out[key] = value
    }
  }
  return out
}

/** Chinese dictionary: fragments first, the shared vocabulary authoritative. */
export const zh: Dict = merge([marketZh, settingsZh, commonZh], [marketEn, settingsEn, commonEn])

/** English dictionary: fragments first, the shared vocabulary authoritative. */
export const en: Dict = merge([marketEn, settingsEn, commonEn], [marketZh, settingsZh, commonZh])
