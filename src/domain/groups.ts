/**
 * Custom plugin groups — (`groups` / `groupOrder`) /
 *
 * A group is a named collection of installed plugins whose enable/disable
 * state can be switched as a unit ("group by capability, toggle as one").
 * Membership lives in the galaxy state (`<profile>/.dsh-galaxy/state.json`)
 * and is the only durable truth: a group's switch state is always derived from
 * its members and never persisted itself.
 *
 * CRUD is written against {@link updateGalaxyState}, which re-reads the file
 * inside the call — two browser tabs editing groups must not lose each other's
 * writes. The batch enable/disable additionally drives the patch layer through
 * `patch.ts` and defers to the theme manager's exclusivity rule, so enabling a
 * theme member switches every other theme off.
 */

import { MAX_GROUP_MEMBERS, MAX_GROUPS, updateGalaxyState } from '../core/state.ts'
import { logEvent } from '../core/log.ts'
import { disableRow, enableRow, isProtectedModule, userPatchPath } from './patch.ts'

/** Group names: letters/digits (incl. CJK), spaces, `_` and `-`; ≤ 40 chars. */
const GROUP_NAME_RE = /^[\p{L}\p{N}_ -]{1,40}$/u

export { MAX_GROUPS, MAX_GROUP_MEMBERS }

/** Result of a group mutation. */
export interface GroupResult {
  ok: boolean
  reason?: string
}

/** Result of a batch group toggle. */
export interface GroupToggleResult {
  ok: boolean
  /** Members the switch was applied to. */
  members: string[]
  /** Members that were enabled. */
  enabled: string[]
  /** Members that were disabled. */
  disabled: string[]
  /** Per-member write failures, when any. */
  failures?: string[]
  reason?: string
}

/** Validate a group name. */
export function validGroupName(name: unknown): name is string {
  return typeof name === 'string' && GROUP_NAME_RE.test(name) && name.trim() !== ''
}

/** Snapshot of the slice group CRUD touches. */
type GroupStateView = { groups: Record<string, string[]>; groupOrder: string[] }

/**
 * Read groups/groupOrder. `updateGalaxyState` is the normalized reader
 * exported by core/state.ts; the mutation callback captures a copy and leaves
 * the document otherwise untouched.
 */
function readGroups(dir: string): GroupStateView {
  let view: GroupStateView = { groups: {}, groupOrder: [] }
  updateGalaxyState(dir, (state) => {
    view = { groups: { ...(state.groups ?? {}) }, groupOrder: [...(state.groupOrder ?? [])] }
  })
  return view
}

/** Persist the group slice, re-reading the rest of the state first. */
function writeGroups(dir: string, view: GroupStateView): void {
  updateGalaxyState(dir, (state) => {
    if (Object.keys(view.groups).length === 0) delete state.groups
    else state.groups = { ...view.groups }
    state.groupOrder = [...view.groupOrder]
  })
}

/** Create a group (RULE quota MAX_GROUPS). */
export function createGroup(dir: string, name: string): GroupResult {
  if (!validGroupName(name)) return { ok: false, reason: 'invalid group name / 分组名称无效' }
  const view = readGroups(dir)
  if (view.groups[name] !== undefined) return { ok: false, reason: 'group already exists / 分组已存在' }
  if (Object.keys(view.groups).length >= MAX_GROUPS) {
    return { ok: false, reason: `group quota reached (${MAX_GROUPS}) / 分组数量已达上限（${MAX_GROUPS}）` }
  }
  view.groups[name] = []
  if (!view.groupOrder.includes(name)) view.groupOrder.push(name)
  writeGroups(dir, view)
  logEvent('info', 'groups', `created "${name}"`)
  return { ok: true }
}

/** Rename a group, keeping its members and display position. */
export function renameGroup(dir: string, name: string, newName: string): GroupResult {
  const view = readGroups(dir)
  if (view.groups[name] === undefined) return { ok: false, reason: 'group not found / 分组不存在' }
  if (!validGroupName(newName)) return { ok: false, reason: 'invalid group name / 分组名称无效' }
  if (newName !== name && view.groups[newName] !== undefined) {
    return { ok: false, reason: 'group already exists / 分组已存在' }
  }
  const members = view.groups[name] ?? []
  delete view.groups[name]
  view.groups[newName] = members
  const index = view.groupOrder.indexOf(name)
  if (index === -1) view.groupOrder.push(newName)
  else view.groupOrder[index] = newName
  writeGroups(dir, view)
  logEvent('info', 'groups', `renamed "${name}" → "${newName}"`)
  return { ok: true }
}

/** Delete a group and drop it from the display order. */
export function deleteGroup(dir: string, name: string): GroupResult {
  const view = readGroups(dir)
  if (view.groups[name] === undefined) return { ok: false, reason: 'group not found / 分组不存在' }
  delete view.groups[name]
  const index = view.groupOrder.indexOf(name)
  if (index !== -1) view.groupOrder.splice(index, 1)
  writeGroups(dir, view)
  logEvent('info', 'groups', `deleted "${name}"`)
  return { ok: true }
}

/**
 * Replace a group's membership.
 *
 * Only installed packages may be members (ghost names are dropped and
 * duplicates collapse) and a group holds at most one theme plugin, mirroring
 * the global one-active-theme rule. The galaxy itself and host infrastructure
 * never participate.
 *
 * @param installed - names known to be installed; when omitted, no membership
 * filtering happens beyond deduplication.
 * @param themes - installed theme names, for the one-theme-per-group rule.
 */
export function setGroupMembers(
  dir: string,
  name: string,
  members: readonly string[],
  installed?: ReadonlySet<string>,
  themes?: ReadonlySet<string>,
): GroupResult {
  const view = readGroups(dir)
  if (view.groups[name] === undefined) return { ok: false, reason: 'group not found / 分组不存在' }
  const kept: string[] = []
  const seen = new Set<string>()
  for (const member of members) {
    if (typeof member !== 'string' || member === '' || seen.has(member)) continue
    if (isProtectedModule(member)) continue
    if (installed !== undefined && !installed.has(member)) continue
    seen.add(member)
    kept.push(member)
    if (kept.length > MAX_GROUP_MEMBERS) {
      return { ok: false, reason: `a group holds at most ${MAX_GROUP_MEMBERS} members / 每组最多 ${MAX_GROUP_MEMBERS} 个成员` }
    }
  }
  if (themes !== undefined) {
    let themeCount = 0
    for (const member of kept) if (themes.has(member)) themeCount += 1
    if (themeCount > 1) return { ok: false, reason: 'a group can contain at most one theme / 每组最多一个主题' }
  }
  view.groups[name] = kept
  writeGroups(dir, view)
  logEvent('info', 'groups', `members of "${name}": ${kept.length}`)
  return { ok: true }
}

/**
 * Batch enable/disable every member of a group.
 *
 * `activateMember` (the theme manager's `activateTheme`) is consulted for
 * members that are themes, so theme exclusivity stays intact; every other
 * member is switched through the patch layer. The galaxy state's disabled list
 * is the durable record the UI reads.
 */
export function setGroupEnabled(
  profile: string,
  dir: string,
  name: string,
  enabled: boolean,
  options: {
    installed?: ReadonlySet<string>
    themes?: ReadonlySet<string>
    activateMember?: (member: string) => boolean
  } = {},
): GroupToggleResult {
  let view: GroupStateView = { groups: {}, groupOrder: [] }
  updateGalaxyState(dir, (state) => {
    view = { groups: { ...(state.groups ?? {}) }, groupOrder: [...(state.groupOrder ?? [])] }
  })
  const groupMembers = view.groups[name]
  if (groupMembers === undefined) {
    return { ok: false, members: [], enabled: [], disabled: [], reason: 'group not found / 分组不存在' }
  }
  const members = groupMembers.filter(member => (options.installed === undefined ? true : options.installed.has(member)))
  const failures: string[] = []
  const enabledMembers: string[] = []
  const disabledMembers: string[] = []
  const patchFile = userPatchPath(profile, dir)
  for (const member of members) {
    try {
      if (enabled && options.themes?.has(member) === true && options.activateMember !== undefined) {
        const activated = options.activateMember(member)
        if (!activated) failures.push(member)
        enabledMembers.push(member)
        continue
      }
      const written = enabled ? enableRow(patchFile, member) : disableRow(patchFile, member)
      // A package with no patch rows at all has nothing to flip; its state.json
      // entry is the whole mechanism, so this is not a failure.
      void written
      if (enabled) enabledMembers.push(member)
      else disabledMembers.push(member)
    } catch (error) {
      failures.push(member)
      logEvent('warn', 'groups', `${name}: ${member} — ${(error as Error).message}`)
    }
  }
  updateGalaxyState(dir, (state) => {
    const next = new Set(state.disabled ?? [])
    for (const member of enabledMembers) next.delete(member)
    for (const member of disabledMembers) next.add(member)
    state.disabled = [...next]
  })
  logEvent('info', 'groups', `${name}: ${enabled ? 'enabled' : 'disabled'} ${members.length} member(s)`)
  return {
    ok: failures.length === 0,
    members,
    enabled: enabledMembers,
    disabled: disabledMembers,
    ...(failures.length === 0 ? {} : { failures, reason: `failed: ${failures.join(', ')}` }),
  }
}

/** Drop `name` from every group (after a successful uninstall). */
export function removeFromGroups(dir: string, name: string): void {
  let changed = false
  updateGalaxyState(dir, (state) => {
    const groups = state.groups
    if (groups === undefined) return
    for (const [group, members] of Object.entries(groups)) {
      if (!members.includes(name)) continue
      groups[group] = members.filter(member => member !== name)
      changed = true
    }
  })
  if (changed) logEvent('info', 'groups', `removed ${name} from every group`)
}

/**
 * Members of one group, filtered to installed packages. `undefined` when the
 * group does not exist.
 */
export function groupMembers(dir: string, name: string): string[] | undefined {
  const view = readGroups(dir)
  return view.groups[name] === undefined ? undefined : [...(view.groups[name] ?? [])]
}
