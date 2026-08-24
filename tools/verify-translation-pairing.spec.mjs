import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  blobHash,
  checkPair,
  discoverPairs,
  documentLinks,
  EXCLUDED,
  parseRecord,
  partition,
  PENDING,
  renderRecord,
  signature,
  verifyTranslationPairing,
  writeRecords,
} from './verify-translation-pairing.mjs'

/** Roots created by {@link corpus}, removed after each test. */
const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Write a throwaway repository containing the given files.
 * @param files - contents keyed by repo-relative path.
 * @returns the root directory.
 */
function corpus(files) {
  const root = mkdtempSync(join(tmpdir(), 'pairing-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** A minimal consistent pair, as the gate wants to find it. */
function pairFiles({ en, zh } = {}) {
  const english = en ?? '# Doc\n\nEnglish | [中文](doc.zh.md)\n\n## Section\n\nBody.\n'
  const chinese = zh ?? '# Doc\n\n[English](doc.md) | 中文\n\n## 章节\n\n正文。\n'
  return {
    'docs/doc.md': english,
    'docs/doc.zh.md': chinese,
    'docs/doc.i18n.yaml': `doc.md: ${blobHash(english)}\ndoc.zh.md: ${blobHash(chinese)}\n`,
  }
}

/**
 * The single pair in a corpus built by {@link pairFiles}.
 * @param root - the corpus root.
 * @returns its check result.
 */
function only(root) {
  const [pair] = discoverPairs(root)
  return checkPair(pair, root)
}

describe('blobHash()', () => {
  it('agrees with git for ASCII and for multi-byte content', () => {
    // `git hash-object` on these exact bytes; the CJK case is the one a
    // character-count implementation gets wrong.
    expect(blobHash('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    expect(blobHash('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    expect(blobHash('中文\n')).toBe(blobHash(Buffer.from('中文\n', 'utf8').toString('utf8')))
  })

  it('hashes by byte length, not character count', () => {
    // Three bytes per character: a `.length`-based implementation would produce
    // the hash of a `blob 3` header instead of `blob 7`.
    const text = '中文\n'
    expect(Buffer.from(text, 'utf8').length).toBe(7)
    expect(blobHash(text)).not.toBe(blobHash('abc\n'))
  })
})

describe('partition()', () => {
  it('keeps hashes and pipes inside a fence out of the prose', () => {
    const { fences, prose } = partition('# H\n\n```sh\n# not a heading\n| not a table\n```\n\ntext\n')
    expect(fences).toEqual([{ info: 'sh', body: '# not a heading\n| not a table' }])
    expect(prose.join('\n')).not.toContain('not a heading')
  })

  it('treats a shorter delimiter inside a longer fence as body', () => {
    const { fences } = partition('````md\n```\ninner\n```\n````\n')
    expect(fences).toHaveLength(1)
    expect(fences[0].body).toBe('```\ninner\n```')
  })
})

describe('signature()', () => {
  it('matches for a faithful translation despite different prose length', () => {
    const en = '# T\n\n## A\n\nA long English paragraph that says a thing.\n\n- one\n- two\n'
    const zh = '# T\n\n## 甲\n\n短句。\n\n- 一\n- 二\n'
    expect(signature(zh)).toEqual(signature(en))
  })

  it('counts table rows without the delimiter row, and records columns', () => {
    const { tables } = signature('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n')
    expect(tables).toEqual([{ rows: 3, columns: 2 }])
  })

  it('separates an ordered list from an unordered one and records its start', () => {
    const { lists } = signature('- a\n- b\n\ntext\n\n3. c\n4. d\n')
    expect(lists).toEqual([
      { kind: 'ul', start: undefined, items: 2 },
      { kind: 'ol', start: 3, items: 2 },
    ])
  })

  it('diverges when a heading level changes', () => {
    expect(signature('# T\n\n### A\n')).not.toEqual(signature('# T\n\n## A\n'))
  })
})

describe('documentLinks()', () => {
  it('collects relative targets and drops the switcher, anchors, and URLs', () => {
    const text = '# T\n\n[English](doc.md) | 中文\n\n[a](docs/a.md) [b](#here) [c](https://example.test)\n'
    expect(documentLinks(text)).toEqual(['docs/a.md'])
  })
})

describe('parseRecord() and renderRecord()', () => {
  it('round-trips a record through its rendered form', () => {
    const pair = { en: 'docs/doc.md', zh: 'docs/doc.zh.md' }
    const hashes = { 'doc.md': 'a'.repeat(40), 'doc.zh.md': 'b'.repeat(40) }
    expect(parseRecord(renderRecord(pair, hashes))).toEqual(hashes)
  })

  it('ignores comments, including one naming a path', () => {
    expect(parseRecord(`# see docs/doc.md: ${'c'.repeat(40)}\ndoc.md: ${'a'.repeat(40)}\n`))
      .toEqual({ 'doc.md': 'a'.repeat(40) })
  })
})

describe('discoverPairs()', () => {
  it('finds root documents and every docs/*.md, and never a .zh.md', () => {
    const root = corpus({
      'README.md': '', 'README.zh.md': '', 'ROADMAP.md': '',
      'docs/usage.md': '', 'docs/usage.zh.md': '', 'docs/design.md': '',
    })
    const names = discoverPairs(root).map(pair => pair.en)
    expect(names).toContain('README.md')
    expect(names).toContain('docs/usage.md')
    expect(names).toContain('docs/design.md')
    expect(names.some(name => name.endsWith('.zh.md'))).toBe(false)
  })

  it('excludes the English-only and generated documents', () => {
    const root = corpus({ 'README.md': '', 'AGENTS.md': '', 'docs/i18n.md': '' })
    const names = discoverPairs(root).map(pair => pair.en)
    expect(names).toEqual(['README.md'])
    expect(EXCLUDED.has('AGENTS.md')).toBe(true)
  })

  it('derives the counterpart and record paths from the English one', () => {
    const root = corpus({ 'docs/usage.md': '' })
    expect(discoverPairs(root)).toEqual([
      { name: 'docs/usage', en: 'docs/usage.md', zh: 'docs/usage.zh.md', record: 'docs/usage.i18n.yaml' },
    ])
  })
})

describe('checkPair()', () => {
  it('passes a consistent pair', () => {
    const result = only(corpus(pairFiles()))
    expect(result.problems).toEqual([])
    expect(result.state).toBe('ok')
  })

  it('reports a pair whose counterpart or record is absent', () => {
    const result = only(corpus({ 'docs/doc.md': '# Doc\n' }))
    expect(result.state).toBe('missing')
    expect(result.problems).toEqual(['docs/doc.zh.md is missing', 'docs/doc.i18n.yaml is missing'])
  })

  it('goes out-of-sync when either side is edited without re-recording', () => {
    const files = pairFiles()
    files['docs/doc.zh.md'] += '\n新增一行。\n'
    const result = only(corpus(files))
    expect(result.state).toBe('out-of-sync')
    expect(result.problems.join('\n')).toContain('doc.zh.md changed since the pair was confirmed')
  })

  it('requires the Chinese backlink after the H1', () => {
    const result = only(corpus(pairFiles({ zh: '# Doc\n\n## 章节\n\n正文。\n' })))
    expect(result.problems.join('\n')).toContain('must carry `[English](doc.md) | 中文`')
  })

  it('requires the English switcher after the H1', () => {
    const result = only(corpus(pairFiles({ en: '# Doc\n\n## Section\n\nBody.\n' })))
    expect(result.problems.join('\n')).toContain('must carry `English | [中文](doc.zh.md)`')
  })

  it('rejects a dropped table row', () => {
    const en = '# Doc\n\nEnglish | [中文](doc.zh.md)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n'
    const zh = '# Doc\n\n[English](doc.md) | 中文\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n'
    expect(only(corpus(pairFiles({ en, zh }))).problems.join('\n')).toContain('table shape differs')
  })

  it('rejects a reordered heading structure', () => {
    const en = '# Doc\n\nEnglish | [中文](doc.zh.md)\n\n## A\n\n### B\n'
    const zh = '# Doc\n\n[English](doc.md) | 中文\n\n## 甲\n\n## 乙\n'
    expect(only(corpus(pairFiles({ en, zh }))).problems.join('\n')).toContain('heading structure differs')
  })

  it('rejects a translated code fence body', () => {
    const en = '# Doc\n\nEnglish | [中文](doc.zh.md)\n\n```sh\ndshline --setup   # once\n```\n'
    const zh = '# Doc\n\n[English](doc.md) | 中文\n\n```sh\ndshline --setup   # 只需一次\n```\n'
    expect(only(corpus(pairFiles({ en, zh }))).problems.join('\n'))
      .toContain('fence 1 body is not byte-identical')
  })

  it('rejects a fence whose info string was translated', () => {
    const en = '# Doc\n\nEnglish | [中文](doc.zh.md)\n\n```sh\nls\n```\n'
    const zh = '# Doc\n\n[English](doc.md) | 中文\n\n```shell\nls\n```\n'
    expect(only(corpus(pairFiles({ en, zh }))).problems.join('\n')).toContain('info string differs')
  })

  it('requires a link into the bilingual corpus to use its own locale', () => {
    const files = {
      'docs/other.md': '# O\n\nEnglish | [中文](other.zh.md)\n',
      'docs/other.zh.md': '# O\n\n[English](other.md) | 中文\n',
      'docs/other.i18n.yaml': '',
      ...pairFiles({
        en: '# Doc\n\nEnglish | [中文](doc.zh.md)\n\nSee [other](other.md).\n',
        zh: '# Doc\n\n[English](doc.md) | 中文\n\n参见[其他](other.md)。\n',
      }),
    }
    const root = corpus(files)
    const pair = discoverPairs(root).find(entry => entry.en === 'docs/doc.md')
    expect(checkPair(pair, root).problems.join('\n'))
      .toContain('should be `other.zh.md` on the Chinese side')
  })

  it('leaves a link outside the corpus in its authored form', () => {
    const files = pairFiles({
      en: '# Doc\n\nEnglish | [中文](doc.zh.md)\n\nSee [agents](../AGENTS.md).\n',
      zh: '# Doc\n\n[English](doc.md) | 中文\n\n参见 [agents](../AGENTS.md)。\n',
    })
    expect(only(corpus(files)).problems).toEqual([])
  })
})

describe('PENDING', () => {
  it('reports an untranslated in-scope document without failing', () => {
    const root = corpus({ 'README.md': '# R\n' })
    const [result] = verifyTranslationPairing({ root, only: ['README.md'] })
    expect(PENDING.has('README.md')).toBe(true)
    expect(result.state).toBe('pending')
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual(['README.zh.md is missing', 'README.i18n.yaml is missing'])
  })

  it('still fails a half-built pair, pending or not', () => {
    // One file without its record is exactly the state that produced the drift
    // this gate exists to prevent, so being on the list does not excuse it.
    const root = corpus({ 'README.md': '# R\n', 'README.zh.md': '# R\n' })
    const [result] = verifyTranslationPairing({ root, only: ['README.md'] })
    expect(result.state).toBe('missing')
    expect(result.problems).toEqual(['README.i18n.yaml is missing'])
  })

  it('demands the entry be removed once the pair is complete', () => {
    const en = '# R\n\nEnglish | [中文](README.zh.md)\n'
    const zh = '# R\n\n[English](README.md) | 中文\n'
    const root = corpus({
      'README.md': en,
      'README.zh.md': zh,
      'README.i18n.yaml': `README.md: ${blobHash(en)}\nREADME.zh.md: ${blobHash(zh)}\n`,
    })
    const [result] = verifyTranslationPairing({ root, only: ['README.md'] })
    expect(result.problems.join('\n')).toContain('remove it from PENDING')
  })
})

describe('verifyTranslationPairing()', () => {
  it('checks only the named pair, addressed by any of its three files', () => {
    const root = corpus({ ...pairFiles(), 'README.md': '# R\n' })
    for (const name of ['docs/doc.md', 'docs/doc.zh.md', 'docs/doc.i18n.yaml', 'docs/doc']) {
      expect(verifyTranslationPairing({ root, only: [name] }).map(result => result.pair.name))
        .toEqual(['docs/doc'])
    }
  })

  it('refuses a name that is not in scope', () => {
    const root = corpus(pairFiles())
    expect(() => verifyTranslationPairing({ root, only: ['docs/nope.md'] }))
      .toThrow('does not name a document in the bilingual scope')
  })
})

describe('writeRecords()', () => {
  it('re-records a confirmed pair and returns it to green', () => {
    const files = pairFiles()
    files['docs/doc.zh.md'] += '\n新增一行。\n'
    const root = corpus(files)
    expect(only(root).state).toBe('out-of-sync')

    expect(writeRecords(['docs/doc.md'], root)).toEqual(['docs/doc'])
    expect(only(root).state).toBe('ok')
    expect(readFileSync(join(root, 'docs/doc.i18n.yaml'), 'utf8')).toContain('pnpm run verify-docs --write')
  })

  it('refuses to record a pair whose counterpart is missing', () => {
    const root = corpus({ 'docs/doc.md': '# Doc\n' })
    expect(() => writeRecords(['docs/doc.md'], root)).toThrow('cannot record docs/doc')
  })

  it('requires naming the pairs, because the yaml diff is the confirmation', () => {
    expect(() => writeRecords([], corpus(pairFiles()))).toThrow('needs the pairs you confirmed')
  })
})
