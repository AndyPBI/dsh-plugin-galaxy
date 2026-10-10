/**
 * Post-operation confirmation via the host Toast primitive.
 *
 * The section cannot know when a long host operation finishes once the panel
 * is closed, so this overlay polls `GET /dsh-galaxy/status` itself and shows
 * one banner on the busy -> idle edge. It renders nothing while idle, and an
 * unreachable API is a warning in the console — never a crash in the shell
 * overlay, which would take the whole page down with it.
 */

import { useEffect, useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconSparkle } from './icons.ts'
import { fetchStatus } from './market-data.ts'
import type { Translate } from './market-data.ts'

/** Poll cadence: fast enough to feel immediate, slow enough to stay cheap. */
const POLL_MS = 2500

/** Whether a status payload describes work still in flight. */
function isBusy(status: { busy?: boolean; progress?: { active?: boolean } }): boolean {
  return status.busy === true || status.progress?.active === true
}

/** The package the active operation is working on, when it names one. */
function busyTarget(status: { progress?: { target?: string; currentPackage?: string } }): string {
  return status.progress?.target ?? status.progress?.currentPackage ?? ''
}

export function InstallToast(props: { t: Translate }) {
  const t = props.t
  const [text, setText] = useState<string | null>(null)
  /** Latest translate function, so a re-bound `t` never restarts the poll. */
  const translateRef = useRef(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])

  useEffect(() => {
    let live = true
    let inFlight = false
    /** Configured once here (not in render) so the edge survives re-renders. */
    let wasBusy = false
    let target = ''
    let warned = false

    const poll = async (): Promise<void> => {
      // One request at a time: a slow host must not stack up polls.
      if (inFlight || !live) return
      inFlight = true
      try {
        const status = await fetchStatus()
        if (!live) return
        const busy = isBusy(status)
        if (busy) {
          target = busyTarget(status) || target
        } else if (wasBusy) {
          const name = target
          target = ''
          setText(name === '' ? translateRef.current('done') : `${name} · ${translateRef.current('done')}`)
        }
        wasBusy = busy
      } catch (error) {
        if (!warned) {
          warned = true
          console.warn('[dsh-plugin-galaxy] status polling unavailable; the install toast stays quiet', error)
        }
      } finally {
        inFlight = false
      }
    }

    void poll()
    const timer = setInterval(() => { void poll() }, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  if (text === null) return null
  return (
    <Toast
      text={text}
      icon={<IconSparkle size={14} />}
      onDone={() => setText(null)}
    />
  )
}
