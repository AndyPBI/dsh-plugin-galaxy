/**
 * The snapshot `GET /status` hands the browser while a package
 * operation runs.
 *
 * The tracker existed, was reported by `/status`, and was NEVER FED: nothing
 * called `start`/`apply`/`finish`, so the panel's progress was permanently
 * `{ active: false }` and a long install showed a bare "busy" line with no way
 * to tell it apart from a hang. These cases pin the feeding rules — what a
 * chunk of child output becomes — with the shapes pnpm and the `dsh` CLI
 * actually print.
 */

import { describe, expect, it } from 'vitest'

import { ProgressTracker } from '../src/domain/progress.ts'

describe('progress tracker output', () => {
  it('reports nothing before an operation starts', () => {
    const snapshot = new ProgressTracker().snapshot()
    expect(snapshot.active).toBe(false)
    expect(snapshot.lines).toBeUndefined()
  })

  it('keeps the child output as lines, newest last', () => {
    const tracker = new ProgressTracker()
    tracker.start('dsh-knowledge')

    tracker.outputLines('✓ Lockfile passes supply-chain policies (verified 7m ago)\n')
    tracker.outputLines('Progress: resolved 173, reused 54, downloaded 1, added 1, done\n')

    const snapshot = tracker.snapshot()
    expect(snapshot.active).toBe(true)
    expect(snapshot.target).toBe('dsh-knowledge')
    expect(snapshot.lines).toEqual([
      '✓ Lockfile passes supply-chain policies (verified 7m ago)',
      'Progress: resolved 173, reused 54, downloaded 1, added 1, done',
    ])
  })

  it('holds a partial line until its newline arrives', () => {
    const tracker = new ProgressTracker()
    tracker.start('demo')
    // Chunks split mid-line: the panel must not show half a line, and must not
    // lose the rest of it.
    tracker.outputLines('Progress: reso')
    expect(tracker.snapshot().lines).toBeUndefined()
    tracker.outputLines('lved 9, reused 0, downloaded 2, added 1, done\n')
    expect(tracker.snapshot().lines).toEqual(['Progress: resolved 9, reused 0, downloaded 2, added 1, done'])
  })

  it('lifts the counters out of pnpm\'s summary line', () => {
    const tracker = new ProgressTracker()
    tracker.start('demo')
    tracker.outputLines('Progress: resolved 173, reused 54, downloaded 3, added 2, done\n')
    const snapshot = tracker.snapshot()
    expect(snapshot.downloaded).toBe(3)
    expect(snapshot.done).toBe(2)
    expect(snapshot.detail).toBe('Progress: resolved 173, reused 54, downloaded 3, added 2, done')
  })

  it('bounds the ring so a chatty install cannot grow the status payload', () => {
    const tracker = new ProgressTracker()
    tracker.start('demo')
    for (let index = 1; index <= 40; index += 1) tracker.outputLines(`line ${String(index)}\n`)
    const lines = tracker.snapshot().lines ?? []
    expect(lines).toHaveLength(8)
    expect(lines.at(-1)).toBe('line 40')
    expect(lines.at(0)).toBe('line 33')
  })

  it('drops the previous operation output when a new one starts', () => {
    const tracker = new ProgressTracker()
    tracker.start('first')
    tracker.outputLines('old output\n')
    tracker.start('second')
    expect(tracker.snapshot().lines).toBeUndefined()
    expect(tracker.snapshot().target).toBe('second')
  })

  it('keeps the phase and timings after the operation ends', () => {
    const tracker = new ProgressTracker()
    tracker.start('demo')
    tracker.phase('install')
    tracker.outputLines('Progress: resolved 1, reused 0, downloaded 1, added 1, done\n')
    tracker.phase('done')
    tracker.finish()
    const snapshot = tracker.snapshot()
    expect(snapshot.active).toBe(false)
    expect(snapshot.phase).toBe('done')
    // Still displayable: what just finished, and what it printed.
    expect(snapshot.lines).toHaveLength(1)
  })
})
