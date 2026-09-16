/**
 * Release channels of Plugin Galaxy itself.
 *
 * A channel is the question "which build of THIS plugin do I accept?", not a
 * licence to pull other authors' prereleases: only the galaxy package itself
 * follows the setting, every other plugin is compared against `latest`
 * (business rule).
 *
 * `Channel` itself lives in `core/types.ts` and is re-exported here so that
 * consumers of the channel rules import one module.
 */

import type { Channel } from '../core/types.ts'

export type { Channel }

/**
 * Every channel a user may pick. All three, always.
 *
 * The dist-tags behind them are published differently: `stable` is a tagged
 * release, `beta` a prerelease cut, and `dev` is published straight from a
 * branch so its version carries a timestamp plus a short SHA
 * (`1.15.0-dev.20260818-3f1432e`) and is never reused. That is what makes a
 * dev build disposable — nothing in the repository's history refers to it.
 */
export const CHANNELS: readonly Channel[] = ['stable', 'beta', 'dev']

/**
 * The npm dist-tag each channel installs from.
 *
 * Kept as a table rather than a switch so that `distTagFor` has exactly one
 * source of truth and a new channel is a compile error at every consumer.
 */
export const DIST_TAG: Record<Channel, string> = {
  stable: 'latest',
  beta: 'beta',
  dev: 'dev',
}

/** Narrow an untrusted value to a {@link Channel}, or `undefined`. */
export function asChannel(value: unknown): Channel | undefined {
  return value === 'stable' || value === 'beta' || value === 'dev' ? value : undefined
}

/** The npm dist-tag a channel installs from (`stable` → `latest`). */
export function distTagFor(channel: Channel): string {
  return DIST_TAG[channel]
}

/**
 * The dist-tags a channel accepts, widest channel last.
 *
 * A channel is a SET, not a tag. Someone on beta has not stopped accepting
 * releases — they accept releases and prereleases — so beta means
 * {latest, beta} and dev means {latest, beta, dev}. Reading it as one tag
 * gets a real case wrong: once a release ships, `beta` still points at the
 * older prerelease until the next one is cut, and following that tag
 * literally would walk a subscriber BACKWARDS onto a build their channel has
 * already moved past.
 */
export function channelTags(channel: Channel): string[] {
  switch (channel) {
    case 'stable': return [DIST_TAG.stable]
    case 'beta': return [DIST_TAG.stable, DIST_TAG.beta]
    case 'dev': return [DIST_TAG.stable, DIST_TAG.beta, DIST_TAG.dev]
  }
}

/**
 * The channel a running build belongs to, derived from its version.
 *
 * Used only when nothing has been chosen on record: installing
 * `dsh-plugin-galaxy@beta` by hand IS the subscription, and treating that as
 * "stable" costs updates rather than clarity. A build published from a branch
 * carries a `-dev.<timestamp>` prerelease, so `dev` is distinguishable from
 * an ordinary prerelease.
 */
export function channelFromVersion(version: string): Channel {
  const prerelease = /-([0-9A-Za-z.-]+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(version.trim())?.[1]
  if (prerelease === undefined) return 'stable'
  return prerelease.startsWith('dev') ? 'dev' : 'beta'
}
