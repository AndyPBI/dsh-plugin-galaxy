import { describe, expect, it } from 'vitest'
import { recordFromStatus, INTERRUPTED_REASON } from '../src/client/operations.ts'
import type { GalaxyStatus } from '../src/client/market-data.ts'

/** The module reads a structural subset; the cast keeps the fixture small. */
const status = (value: unknown): GalaxyStatus => value as GalaxyStatus
const active = {
  busy: true,
  progress: { active: true, target: 'dsh-demo', phase: 'install', percent: 42, detail: '正在安装 dsh-demo' },
}
const idle = { busy: false, progress: { active: false } }

describe('operations — a settled record drops its running progress', () => {
  it('clears percent and the progress detail when the host goes idle', () => {
    const records = recordFromStatus([], status(active), 'boot-1')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ name: 'dsh-demo', kind: 'install', state: 'running', percent: 42 })

    const settled = recordFromStatus(records, status(idle), 'boot-1')
    expect(settled[0]).toMatchObject({ state: 'done', needsRefresh: true })
    expect(settled[0]?.percent).toBeUndefined()
    expect(settled[0]?.detail).toBeUndefined()
  })

  it('marks a running record from another boot as failed without its progress', () => {
    const records = recordFromStatus([], status(active), 'boot-1')
    const after = recordFromStatus(records, status(idle), 'boot-2')
    expect(after[0]).toMatchObject({ state: 'failed', reason: INTERRUPTED_REASON })
    expect(after[0]?.percent).toBeUndefined()
    expect(after[0]?.detail).toBeUndefined()
  })
})
