import { describe, expect, it } from 'vitest'
import {
  branchCandidates,
  branchFromDirName,
  decideAction,
  findUpstreamConflicts,
} from '../scripts/update-curated-plugins.mjs'

describe('branchFromDirName：目录名后缀就是下载时的分支', () => {
  it('识别 -main / -master', () => {
    expect(branchFromDirName('dsh-mcp-main')).toBe('main')
    expect(branchFromDirName('dsh-office-plugin-master')).toBe('master')
  })

  it('后缀不可信时返回 null，不猜', () => {
    expect(branchFromDirName('dsh-office-plugin')).toBeNull()
    expect(branchFromDirName('something-mail')).toBeNull()
  })
})

describe('branchCandidates：尝试顺序', () => {
  it('URL 里写死的分支优先，其余按后缀与默认分支兜底', () => {
    expect(branchCandidates('x-main', null)).toEqual(['main', 'master'])
    expect(branchCandidates('x-master', null)).toEqual(['master', 'main'])
    expect(branchCandidates('x', 'dev')).toEqual(['dev', 'main', 'master'])
    expect(branchCandidates('x-main', 'main')).toEqual(['main', 'master'])
  })
})

describe('decideAction：只在远端严格更新时覆盖', () => {
  it('本地缺失 / 远端更新 → update', () => {
    expect(decideAction(null, '1.0.0')).toBe('update')
    expect(decideAction('1.0.0', '1.0.1')).toBe('update')
    expect(decideAction('1.0.0', '2.0.0')).toBe('update')
  })

  it('版本相同 → skip', () => {
    expect(decideAction('1.0.0', '1.0.0')).toBe('skip')
    expect(decideAction('0.3.3-rc.1', '0.3.3-rc.1')).toBe('skip')
  })

  it('本地领先 → ahead，绝不降级（含 1.0.61 > 1.0.8 这类排序陷阱）', () => {
    expect(decideAction('2.0.0', '1.0.0')).toBe('ahead')
    expect(decideAction('1.0.61', '1.0.8')).toBe('ahead')
  })

  it('远端读不到版本 → unchecked', () => {
    expect(decideAction('1.0.0', null)).toBe('unchecked')
  })

  it('版本号无法解析时退化为字符串比较', () => {
    expect(decideAction('dev', 'dev')).toBe('skip')
    expect(decideAction('dev', 'nightly')).toBe('update')
  })
})

describe('findUpstreamConflicts：同一仓库不能同时进甄选和上游', () => {
  it('按 owner/repo 比对，忽略 /tree/ 子路径写法', () => {
    const conflicts = findUpstreamConflicts(
      [
        ['dsh-personal-workbench-main', 'https://github.com/Dely0/dsh-personal-workbench'],
        ['dsh-synapse-main', 'https://github.com/liangmianya/dsh-synapse'],
      ],
      ['https://github.com/Dely0/dsh-personal-workbench/tree/main/packages/app'],
    )
    expect(conflicts).toEqual([{ dirName: 'dsh-personal-workbench-main', key: 'Dely0/dsh-personal-workbench' }])
  })

  it('没有交集时返回空数组', () => {
    expect(
      findUpstreamConflicts([['x', 'https://github.com/a/x']], ['https://github.com/b/y']),
    ).toEqual([])
  })
})
