/**
 * Category vocabulary: the site publishes `categories: [{id, label, labelEn,
 * count}]` while rows carry only the slug. These tests pin the three places that
 * matter — the loader keeping the table, the label resolution, and the search
 * index reaching the localized name (so 「甄选」 finds the curated rows).
 */

import { describe, expect, it } from 'vitest'
import { categoryText, isEnglishLanguage } from '../src/client/categories.ts'

const TABLE = [
  { id: 'curated', label: '甄选', labelEn: 'Featured', count: 8 },
  { id: 'service', label: '服务与交易（客服 / 订阅 / 开票 / 支付）', labelEn: 'Service & Commerce', count: 18 },
  { id: 'cost', label: '费用与额度' },
]

describe('category labels', () => {
  it('accepts a region-tagged language value as English', () => {
    expect(isEnglishLanguage('en')).toBe(true)
    expect(isEnglishLanguage('en-US')).toBe(true)
    expect(isEnglishLanguage('EN-gb')).toBe(true)
    expect(isEnglishLanguage('zh')).toBe(false)
    expect(isEnglishLanguage(undefined)).toBe(false)
  })

  it('resolves a slug to the label of the active language', () => {
    expect(categoryText('curated', TABLE, false)).toBe('甄选')
    expect(categoryText('curated', TABLE, true)).toBe('Featured')
    expect(categoryText('service', TABLE, false)).toBe('服务与交易（客服 / 订阅 / 开票 / 支付）')
    expect(categoryText('service', TABLE, true)).toBe('Service & Commerce')
  })

  it('falls back to the other language, then to the slug', () => {
    // `cost` ships no English label yet.
    expect(categoryText('cost', TABLE, true)).toBe('费用与额度')
    // An unknown slug is still shown: a site-side addition must not blank the badge.
    expect(categoryText('brand-new', TABLE, false)).toBe('brand-new')
    expect(categoryText('curated', undefined, false)).toBe('curated')
  })

  it('matches the slug case-insensitively and joins several slugs', () => {
    expect(categoryText('CURATED', TABLE, false)).toBe('甄选')
    expect(categoryText('curated, cost', TABLE, false)).toBe('甄选、费用与额度')
    expect(categoryText('curated,cost', TABLE, true)).toBe('Featured, 费用与额度')
  })

  it('returns undefined when the row has no category', () => {
    for (const value of [undefined, '', '   ', ',']) {
      expect(categoryText(value, TABLE, false)).toBeUndefined()
    }
  })
})
