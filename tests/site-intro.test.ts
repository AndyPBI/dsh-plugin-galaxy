import { describe, expect, it } from 'vitest'
import { indexSiteCatalog } from '../src/domain/site-intro.ts'

/** The site's catalog uses desc/descFull/descEn; the dialog reads that shape. */
const CATALOG = {
  plugins: [
    { key: 'liustack/modsearch', name: 'modsearch', desc: '短简介', descFull: '完整的官网简介。', descEn: 'The full English intro.' },
    { key: 'kw78/dsh-office-tools', name: 'dsh-office-tools', desc: '<b>加粗</b>的简介<br>第二行' },
    { name: 'installed-only', desc: 'No key on this row' },
  ],
}

describe('site intro catalog', () => {
  it('indexes rows by their owner/name key and by name', () => {
    const index = indexSiteCatalog(CATALOG)
    expect(index.byKey.get('liustack/modsearch')).toMatchObject({
      name: 'modsearch',
      description: '短简介',
      descriptionFull: '完整的官网简介。',
      descriptionEn: 'The full English intro.',
    })
    expect(index.byName.get('modsearch')?.key).toBe('liustack/modsearch')
    expect(index.byName.get('installed-only')?.key).toBe('installed-only')
  })

  it('turns the site markup into plain prose and keeps its line break', () => {
    const index = indexSiteCatalog(CATALOG)
    expect(index.byKey.get('kw78/dsh-office-tools')?.description).toBe('加粗 的简介\n第二行')
  })

  it('returns an empty index for a missing or malformed catalog', () => {
    expect(indexSiteCatalog(undefined).byKey.size).toBe(0)
    expect(indexSiteCatalog({ plugins: 'nope' }).byName.size).toBe(0)
  })
})
