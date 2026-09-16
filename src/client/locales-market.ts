/**
 * zh/en dictionaries for the Plugin Galaxy settings section.
 *
 * Every string MarketSection.tsx / CommentsModal.tsx renders lives here, so a
 * key can never be half-translated: the two literals are checked against the
 * same `Dict` shape and the key sets are compared below at compile time.
 *
 * Placeholders use `{name}` — the host locale service substitutes `\w+` names
 * from the `params` argument (`translate()` in @deepseek-ai/dsh-client-locale).
 */

/** Dictionary shape registered with the host locale service. */
export type Dict = Record<string, string>

const zh = {
  // Tabs / heading (/) ——
  subtitle: '于万千插件中甄选价值，DeepSeek Harness 扩展更轻盈',
  tabDiscover: '发现',
  tabInstalled: '已安装',
  tabFavorites: '收藏',
  tabThemes: '主题',
  tabList: '列表',
  tabGroups: '分组',

  // Operations section / panels (and friends) ——
  sectionOperations: '任务',
  opsCount: '共 {count} 条记录',
  opsShow: '展开',
  opsHide: '收起',
  panelSnapshot: '快照',
  panelPresets: '预设',
  panelDiagnostics: '诊断',

  // Discover toolbar ——
  searchPh: '搜索插件，例如：通知、终端、记忆…',
  searchInstalledPh: '搜索已安装插件…',
  searchFavoritesPh: '搜索收藏…',
  reload: '刷新',
  filterLabel: '筛选',
  filterAll: '全部',
  filterInstalled: '已安装',
  recommendNote: '综合推荐前 {count} 条 · 完整目录见「全部」',
  bandLabel: '推荐',
  rankLabel: '推荐第 {rank} 名',
  scorePartsLabel: '得分项',
  pinBadge: '编辑推荐',
  filterNotInstalled: '未安装',
  filterRecommended: '推荐',
  filterUpdateable: '可更新',
  filterIncompatible: '不兼容',
  sortLabel: '排序',
  sortName: '名称',
  sortStars: 'Star 数',
  sortDownloads: 'npm 下载量',
  sortAdded: '发布时间',
  sortAsc: '升序',
  sortDesc: '降序',
  resultCount: '{count} 个插件',
  installedCount: '{count} 项已安装',
  favoritesCount: '{count} 个收藏',
  themeResultCount: '{count} 款主题',

  // Compatibility badges ——
  compatCompatible: '兼容',
  compatIncompatible: '不兼容',
  compatUnknown: '兼容性未知',
  compatNote: '依据插件声明或公开 manifest 判断，未声明的插件仍可安装',

  // —— Card badges / metadata ——
  installedBadge: '✓ 已安装',
  updateAvailableBadge: '可更新',
  deprecatedBadge: '已废弃',
  disabledBadge: '已停用',
  bundleBadge: 'bundle',
  versionLabel: '版本',
  hostVersionLabel: '宿主',
  hostVersionHint: '本 profile 构建所依据的宿主版本（来源：{source}）',
  sourceLabel: '来源',
  starsLabel: 'Star',
  downloadsLabel: '下载量',
  categoryLabel: '分类',
  notInstalled: '未安装',
  replacementHint: '目录建议改用',
  installReplacement: '安装替代品',

  // —— Catalog identity, paging and manual refresh ——
  // Shown when two rows in the same listing share a display name: they are
  // different plugins, and the owner is what tells them apart.
  ownerLabel: '作者',
  showMore: '显示更多（还剩 {count} 个）',
  reloadBusy: '刷新中…',
  refreshedAt: '已刷新 {time}',

  // —— A change the running host has not picked up ——
  // Uninstalling removes the package, but a plugin the host already mounted
  // stays in memory (and in the sidebar) until the process restarts.
  restartNeededTitle: '需要重启才能完全生效',
  restartNeededBody: '变更已写入 profile，但当前宿主进程仍在运行旧状态（插件仍在内存与侧栏中）。请完整重启 DeepSeek Harness。',

  // —— Contract kind labels (InstallKind) ——
  kindNpm: 'npm',
  kindGit: 'git',
  kindLocal: '本地',
  kindTarball: '压缩包',
  kindAlias: '别名',
  kindUnknown: '未知',

  // Buttons (update / uninstall / rollback / toggle) ——
  install: '安装',
  installing: '安装中…',
  update: '更新',
  updating: '更新中…',
  uninstall: '卸载',
  uninstalling: '卸载中…',
  rollback: '回滚',
  rollingBack: '回滚中…',
  enable: '启用',
  disable: '停用',
  save: '保存',
  cancel: '取消',
  close: '关闭',
  retry: '重试',

  // —— Confirm dialogs ——
  installConfirmTitle: '安装插件',
  installConfirmBody: '插件是社区第三方代码。安装即表示你信任该来源；构建脚本默认被禁止执行。',
  installConfirmAction: '确认安装',
  uninstallConfirmTitle: '卸载插件',
  uninstallConfirmBody: '将从当前 profile 中移除 {name}。该操作不可撤销。',
  uninstallConfirmAction: '确认卸载',
  rollbackConfirmTitle: '回滚本次操作',
  rollbackConfirmBody: '回滚会按操作前的记录恢复 profile 清单与锁文件，之后需要重启宿主。',
  rollbackConfirmAction: '确认回滚',

  // Note editor ——
  noteAdd: '添加备注',
  noteEdit: '编辑备注',
  notePlaceholder: '用你自己的话描述这个插件（最多 200 字）',
  noteSave: '保存备注',
  noteFail: '备注保存失败',

  // Group editor ——
  groupSection: '分组',
  groupNew: '新建分组',
  groupNamePh: '分组名称',
  groupCreate: '创建',
  groupRename: '重命名',
  groupDelete: '删除分组',
  groupConfirmDelete: '确认删除？',
  groupAssign: '加入分组',
  groupRemove: '移出',
  ungrouped: '未分组',
  groupEmpty: '该组暂无成员',
  noGroups: '尚无分组，请先新建',
  groupMixed: '部分启用',
  groupMembers: '{count} 个成员',
  groupToggleAll: '整组启停',
  groupFail: '分组操作失败',

  // Favorites ——
  favoriteAdd: '加入收藏',
  favoriteRemove: '取消收藏',
  favoriteFailed: '收藏失败，请稍后重试',
  favoriteUnavailable: '该条目不在目录中，无法收藏',
  favoritesEmpty: '还没有收藏。在「发现」中收藏目录条目即可加入。',
  favoritesUnmatched: '收藏的条目已不在目录中。',

  // Comments modal ——
  commentsTitle: '评论',
  commentsOpen: '查看评论',
  commentsEmpty: '该插件暂无评论',
  commentsClose: '关闭',
  commentsNote: '评论来自精选目录的条目数据，不发起额外网络请求。',

  // Changelog dialog ——
  siteOpen: '官网插件页',
  siteOpenHint: '在官网查看该插件的详情与安装说明',
  changelogOpen: '更新内容',
  changelogTitle: '更新内容',
  changelogLoading: '正在加载更新内容…',
  changelogEmpty: '该插件未提供更新说明。',
  changelogFail: '暂时读不到更新内容，稍后再试。',
  changelogCommits: '提交记录',
  changelogCurrent: '当前版本',
  changelogLatest: '最新版本',
  changelogTruncated: '内容已截断',

  // Themes tab ——
  themeApply: '使用',
  themeActive: '使用中',
  themeInstalled: '已安装',
  themeHostActive: '宿主当前主题',
  themeFail: '主题切换失败',
  themesEmpty: '尚未安装主题插件',

  // —— Empty states / loading / errors ——
  noMatch: '没有匹配的插件',
  emptyHint: '换个搜索词或筛选条件试试',
  installedEmpty: '尚未安装社区插件，可前往「发现」页浏览',
  catalogLoading: '正在加载插件目录…',
  loadFail: '插件目录加载失败，请稍后重试',
  loadRetry: '重试',
  installedLoadFail: '已安装列表加载失败',
  errorGeneric: '操作失败',
  toggleFail: '切换失败',
  busyWait: '已有操作正在进行，请等待其完成',
  busy: '处理中…',
  // —— A mutation that may never answer ——
  // The server can take minutes (resolution, downloads, builds); the panel
  // shows how long it has been running rather than a bare "busy", and past
  // the watchdog it offers a way out instead of hanging silently forever.
  busyElapsed: '已用 {seconds} 秒',
  phaseInstall: '安装中',
  phaseVerify: '校验中',
  phaseActivate: '激活中',
  phaseDone: '已完成',
  phaseUpdate: '更新中',
  phaseUninstall: '卸载中',
  progressDownloaded: '已下载',
  progressAdded: '已新增',
  progressOutput: '命令最近输出（来自 pnpm / dsh）',
  busyStalled: '仍在进行中；你可以继续等待，或取消本次操作',
  busyServerSide: '服务端仍有一个操作在执行（可能来自另一个窗口，或本次刷新之前）',
  cancelRequested: '已请求取消；等待服务端结束该操作…',
  mutationCancelled: '已停止等待：本次操作的结果不再显示在这里（服务端仍在收尾，结果会记入日志）',
  mutationTimedOut: '请求在 {minutes} 分钟内没有返回结果，已放弃等待（服务端可能仍在执行）。请查看日志后再重试。',
} satisfies Dict

const en = {
  subtitle: 'Value picked from thousands of plugins — a leaner DeepSeek Harness',
  tabDiscover: 'Discover',
  tabInstalled: 'Installed',
  tabFavorites: 'Favorites',
  tabThemes: 'Themes',
  tabList: 'List',
  tabGroups: 'Groups',

  sectionOperations: 'Tasks',
  opsCount: '{count} record(s)',
  opsShow: 'Show',
  opsHide: 'Hide',
  panelSnapshot: 'Snapshots',
  panelPresets: 'Presets',
  panelDiagnostics: 'Diagnostics',

  searchPh: 'Search plugins: notify, terminal, memory…',
  searchInstalledPh: 'Search installed plugins…',
  searchFavoritesPh: 'Search favorites…',
  reload: 'Refresh',
  filterLabel: 'Filter',
  filterAll: 'All',
  filterInstalled: 'Installed',
  recommendNote: 'Top {count} by composite score · see All for the full catalog',
  bandLabel: 'Ranked',
  rankLabel: 'Recommended #{rank}',
  scorePartsLabel: 'Score parts',
  pinBadge: 'Editor’s pick',
  filterNotInstalled: 'Not installed',
  filterRecommended: 'Recommended',
  filterUpdateable: 'Update available',
  filterIncompatible: 'Incompatible',
  sortLabel: 'Sort',
  sortName: 'Name',
  sortStars: 'Stars',
  sortDownloads: 'npm downloads',
  sortAdded: 'Release date',
  sortAsc: 'Ascending',
  sortDesc: 'Descending',
  resultCount: '{count} plugins',
  installedCount: '{count} installed',
  favoritesCount: '{count} favorites',
  themeResultCount: '{count} themes',

  compatCompatible: 'Compatible',
  compatIncompatible: 'Incompatible',
  compatUnknown: 'Compatibility unknown',
  compatNote: 'Judged from declared host requirements or the public manifest; undeclared plugins can still be installed',

  installedBadge: '✓ Installed',
  updateAvailableBadge: 'Update available',
  deprecatedBadge: 'Deprecated',
  disabledBadge: 'Disabled',
  bundleBadge: 'bundle',
  versionLabel: 'Version',
  hostVersionLabel: 'Host',
  hostVersionHint: 'The host release this profile was built for (source: {source})',
  sourceLabel: 'Source',
  starsLabel: 'Stars',
  downloadsLabel: 'Downloads',
  categoryLabel: 'Category',
  notInstalled: 'Not installed',
  replacementHint: 'Catalog suggests',
  installReplacement: 'Install replacement',

  // —— Catalog identity, paging and manual refresh ——
  ownerLabel: 'By',
  showMore: 'Show more ({count} left)',
  reloadBusy: 'Refreshing…',
  refreshedAt: 'Refreshed {time}',

  // —— A change the running host has not picked up ——
  restartNeededTitle: 'Restart required to take full effect',
  restartNeededBody: 'The change is written to the profile, but this host process still runs the previous state (the plugin is still mounted, and still in the sidebar). Fully restart DeepSeek Harness.',

  kindNpm: 'npm',
  kindGit: 'git',
  kindLocal: 'local',
  kindTarball: 'tarball',
  kindAlias: 'alias',
  kindUnknown: 'unknown',

  install: 'Install',
  installing: 'Installing…',
  update: 'Update',
  updating: 'Updating…',
  uninstall: 'Uninstall',
  uninstalling: 'Uninstalling…',
  rollback: 'Roll back',
  rollingBack: 'Rolling back…',
  enable: 'Enable',
  disable: 'Disable',
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  retry: 'Retry',

  installConfirmTitle: 'Install plugin',
  installConfirmBody: 'Plugins are third-party community code. Installing means you trust this source; build scripts are blocked by default.',
  installConfirmAction: 'Confirm install',
  uninstallConfirmTitle: 'Uninstall plugin',
  uninstallConfirmBody: 'This removes {name} from the current profile. It cannot be undone.',
  uninstallConfirmAction: 'Uninstall',
  rollbackConfirmTitle: 'Roll back this operation',
  rollbackConfirmBody: 'Rolling back restores the profile manifest and lockfile captured before the operation; a restart is needed afterwards.',
  rollbackConfirmAction: 'Roll back',

  noteAdd: 'Add note',
  noteEdit: 'Edit note',
  notePlaceholder: 'Describe it in your own words (200 characters max)',
  noteSave: 'Save note',
  noteFail: 'Could not save the note',

  groupSection: 'Groups',
  groupNew: 'New group',
  groupNamePh: 'Group name',
  groupCreate: 'Create',
  groupRename: 'Rename',
  groupDelete: 'Delete group',
  groupConfirmDelete: 'Delete group?',
  groupAssign: 'Assign to group',
  groupRemove: 'Remove',
  ungrouped: 'Ungrouped',
  groupEmpty: 'No members yet',
  noGroups: 'No groups yet. Create one to begin.',
  groupMixed: 'Partially enabled',
  groupMembers: '{count} member(s)',
  groupToggleAll: 'Toggle all',
  groupFail: 'Group operation failed',

  favoriteAdd: 'Add to favorites',
  favoriteRemove: 'Remove from favorites',
  favoriteFailed: 'Could not update favorites. Try again.',
  favoriteUnavailable: 'This entry is not in the catalog, so it cannot be favorited',
  favoritesEmpty: 'No favorites yet. Bookmark catalog entries in Discover to save them here.',
  favoritesUnmatched: 'Bookmarked entries are no longer in the catalog.',

  commentsTitle: 'Comments',
  commentsOpen: 'Comments',
  commentsEmpty: 'This plugin has no comments yet',
  commentsClose: 'Close',
  commentsNote: 'Comments come from the curated catalog entry; no extra network request is made.',

  siteOpen: 'Plugin page',
  siteOpenHint: "Open this plugin's page on the website",
  changelogOpen: 'What changed',
  changelogTitle: 'What changed',
  changelogLoading: 'Loading update notes…',
  changelogEmpty: 'This plugin does not publish update notes.',
  changelogFail: 'Update notes are unavailable right now — try again later.',
  changelogCommits: 'Commits',
  changelogCurrent: 'Current',
  changelogLatest: 'Latest',
  changelogTruncated: 'Truncated',

  themeApply: 'Use',
  themeActive: 'Active',
  themeInstalled: 'Installed',
  themeHostActive: 'Current host theme',
  themeFail: 'Could not activate the theme',
  themesEmpty: 'No theme plugins installed yet',

  noMatch: 'No plugins match',
  emptyHint: 'Try a different search or filter',
  installedEmpty: 'No community plugins yet — browse the Discover tab',
  catalogLoading: 'Loading the catalog…',
  loadFail: 'The plugin catalog failed to load. Try again later.',
  loadRetry: 'Retry',
  installedLoadFail: 'Could not load the installed plugins',
  errorGeneric: 'The operation failed',
  toggleFail: 'Toggle failed',
  busyWait: 'Another operation is running — please wait for it to finish',
  busy: 'Working…',
  busyElapsed: '{seconds}s elapsed',
  phaseInstall: 'Installing',
  phaseVerify: 'Verifying',
  phaseActivate: 'Activating',
  phaseDone: 'Done',
  phaseUpdate: 'Updating',
  phaseUninstall: 'Uninstalling',
  progressDownloaded: 'downloaded',
  progressAdded: 'added',
  progressOutput: 'Latest command output (from pnpm / dsh)',
  busyStalled: 'Still running — you can keep waiting, or cancel this operation',
  busyServerSide: 'The server still has an operation running (it may come from another window, or from before this page reloaded)',
  cancelRequested: 'Cancellation requested; waiting for the server to end that operation…',
  mutationCancelled: 'Stopped waiting: the result of this operation is no longer shown here (the server is still finishing; it is recorded in the log)',
  mutationTimedOut: 'No result came back within {minutes} minutes, so waiting was abandoned (the server may still be running). Check the log, then retry.',
} satisfies Dict

/**
 * Compile-time proof that both dictionaries cover exactly the same keys.
 *
 * The exported values below are widened to `Dict` (the shape `index.ts`
 * registers), which is why the literal objects are declared separately: this
 * alias sees the literal key unions, and `SameKeys` resolves to `false` — a
 * type error at the assignment — the moment one dictionary gains or loses a
 * key the other does not have.
 */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? ([keyof B] extends [keyof A] ? true : false)
  : false

/** Exported so the parity assertion can never be reported as unused. */
export const MARKET_DICT_KEYS_ALIGNED: SameKeys<typeof zh, typeof en> = true

export const marketZh: Dict = zh
export const marketEn: Dict = en
