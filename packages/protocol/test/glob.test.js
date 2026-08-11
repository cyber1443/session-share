import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { expandBraces, globsIntersect, pathMatchesAny } from '../dist/index.js'

describe('expandBraces', () => {
  it('expands a single group', () => {
    assert.deepEqual(expandBraces('src/{a,b}/x.ts'), ['src/a/x.ts', 'src/b/x.ts'])
  })

  it('expands nested groups', () => {
    assert.deepEqual(expandBraces('src/{a,{b,c}}/x.ts'), [
      'src/a/x.ts',
      'src/b/x.ts',
      'src/c/x.ts',
    ])
  })

  it('leaves unbalanced braces alone', () => {
    assert.deepEqual(expandBraces('src/{a/x.ts'), ['src/{a/x.ts'])
  })
})

describe('globsIntersect', () => {
  it('detects identical globs', () => {
    assert.equal(globsIntersect('src/app/page.tsx', 'src/app/page.tsx'), true)
  })

  it('separates sibling directories', () => {
    assert.equal(globsIntersect('src/theme/**', 'src/settings/**'), false)
  })

  it('detects a star covering a literal', () => {
    assert.equal(globsIntersect('src/theme/*.ts', 'src/theme/toggle.ts'), true)
  })

  it('separates extensions in the same directory', () => {
    assert.equal(globsIntersect('src/theme/*.ts', 'src/theme/*.css'), false)
  })

  it('detects ** swallowing a nested path', () => {
    assert.equal(globsIntersect('src/**', 'src/theme/deep/nested/file.ts'), true)
  })

  it('matches ** against zero segments', () => {
    assert.equal(globsIntersect('src/**', 'src'), true)
  })

  it('treats a bare directory as everything under it', () => {
    assert.equal(globsIntersect('src/theme', 'src/theme/toggle.ts'), true)
  })

  it('separates prefixed filenames', () => {
    assert.equal(globsIntersect('src/use-theme*.ts', 'src/use-settings*.ts'), false)
  })

  it('detects overlapping prefixed filenames', () => {
    assert.equal(globsIntersect('src/use-*.ts', 'src/*-theme.ts'), true)
  })

  it('handles braces on both sides', () => {
    assert.equal(globsIntersect('src/{a,b}/**', 'src/{b,c}/**'), true)
    assert.equal(globsIntersect('src/{a,b}/**', 'src/{c,d}/**'), false)
  })

  it('respects ? as exactly one character', () => {
    assert.equal(globsIntersect('src/a?.ts', 'src/ab.ts'), true)
    assert.equal(globsIntersect('src/a?.ts', 'src/abc.ts'), false)
  })
})

describe('pathMatchesAny', () => {
  it('matches a file under a directory glob', () => {
    assert.equal(pathMatchesAny('src/theme/toggle.tsx', ['src/theme/**']), true)
  })

  it('rejects a file outside every glob', () => {
    assert.equal(pathMatchesAny('src/settings/page.tsx', ['src/theme/**', 'app/theme.ts']), false)
  })

  it('normalises a leading ./', () => {
    assert.equal(pathMatchesAny('./src/theme/toggle.tsx', ['src/theme/*.tsx']), true)
  })

  it('does not let * cross a directory boundary', () => {
    assert.equal(pathMatchesAny('src/theme/deep/toggle.tsx', ['src/theme/*.tsx']), false)
  })
})
