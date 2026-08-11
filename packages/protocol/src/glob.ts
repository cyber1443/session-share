/**
 * Glob overlap detection.
 *
 * The whole safety story rests on one question: can two globs ever match the
 * same file? If they can, two agents can collide in the same file and the
 * decomposition is invalid. This answers that question structurally -- without
 * touching the filesystem, so it works on a decomposition before any of the
 * files it describes exist.
 *
 * Supported: literal segments, `*`, `?`, `**`, and `{a,b}` alternation.
 * Anything more exotic falls back to "assume they overlap", which is the safe
 * direction: it blocks a decomposition rather than allowing a collision.
 */

/** `src/{a,b}/*.ts` -> [`src/a/*.ts`, `src/b/*.ts`] */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]

  let depth = 0
  let close = -1
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return [pattern] // unbalanced, treat literally

  const head = pattern.slice(0, open)
  const tail = pattern.slice(close + 1)
  const alternatives: string[] = []
  let current = ''
  let innerDepth = 0
  for (const ch of pattern.slice(open + 1, close)) {
    if (ch === '{') innerDepth++
    if (ch === '}') innerDepth--
    if (ch === ',' && innerDepth === 0) {
      alternatives.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  alternatives.push(current)

  return alternatives.flatMap((alt) => expandBraces(`${head}${alt}${tail}`))
}

export function normalizeGlob(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Directory globs are shorthand: `src/lib` owns everything under `src/lib`.
 * A trailing `/**` is implied when the last segment has no wildcard and no dot,
 * which is how people actually write ownership globs.
 */
export function toSegments(pattern: string): string[] {
  const normalized = normalizeGlob(pattern)
  const segments = normalized.split('/').filter((s) => s.length > 0)
  const last = segments[segments.length - 1]
  if (last !== undefined && !/[*?.]/.test(last)) segments.push('**')
  return segments
}

/**
 * Can two single-segment patterns match the same name?
 *
 * With at most one `*` each this is exact: split into prefix/suffix and check
 * they are mutually compatible. `*` absorbs any remaining length, so no length
 * arithmetic is needed. With more than one `*`, assume yes.
 */
function segmentsIntersect(a: string, b: string): boolean {
  if (a === b) return true
  if (a === '*' || b === '*') return true

  const aStars = (a.match(/\*/g) ?? []).length
  const bStars = (b.match(/\*/g) ?? []).length

  if (aStars === 0 && bStars === 0) return matchesWithQuestionMarks(a, b)
  if (aStars > 1 || bStars > 1) return true // conservative

  const [aPrefix, aSuffix] = aStars === 1 ? splitOnStar(a) : ([a, null] as const)
  const [bPrefix, bSuffix] = bStars === 1 ? splitOnStar(b) : ([b, null] as const)

  // A literal on one side: the other pattern must be able to match it outright.
  if (aSuffix === null) return literalMatchesStarPattern(a, bPrefix, bSuffix!)
  if (bSuffix === null) return literalMatchesStarPattern(b, aPrefix, aSuffix)

  return prefixCompatible(aPrefix, bPrefix) && suffixCompatible(aSuffix, bSuffix)
}

function splitOnStar(pattern: string): readonly [string, string] {
  const index = pattern.indexOf('*')
  return [pattern.slice(0, index), pattern.slice(index + 1)] as const
}

/** `?` matches exactly one character, so compare position by position. */
function matchesWithQuestionMarks(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ca = a[i]!
    const cb = b[i]!
    if (ca !== cb && ca !== '?' && cb !== '?') return false
  }
  return true
}

function literalMatchesStarPattern(literal: string, prefix: string, suffix: string): boolean {
  if (literal.length < prefix.length + suffix.length) return false
  return (
    matchesWithQuestionMarks(literal.slice(0, prefix.length), prefix) &&
    matchesWithQuestionMarks(literal.slice(literal.length - suffix.length), suffix)
  )
}

function prefixCompatible(a: string, b: string): boolean {
  const shared = Math.min(a.length, b.length)
  return matchesWithQuestionMarks(a.slice(0, shared), b.slice(0, shared))
}

function suffixCompatible(a: string, b: string): boolean {
  const shared = Math.min(a.length, b.length)
  return matchesWithQuestionMarks(a.slice(a.length - shared), b.slice(b.length - shared))
}

/**
 * `**` matches zero or more whole segments, so at each `**` the search branches:
 * consume nothing, or consume one segment from the other side.
 */
function segmentListsIntersect(a: string[], b: string[]): boolean {
  const memo = new Set<string>()

  const walk = (i: number, j: number): boolean => {
    const key = `${i}:${j}`
    if (memo.has(key)) return false
    memo.add(key)

    if (i >= a.length && j >= b.length) return true
    if (i >= a.length) return b.slice(j).every((s) => s === '**')
    if (j >= b.length) return a.slice(i).every((s) => s === '**')

    const head = a[i]!
    const other = b[j]!

    if (head === '**') {
      if (walk(i + 1, j)) return true // ** absorbs nothing
      if (walk(i, j + 1)) return true // ** absorbs one segment of b
      return false
    }
    if (other === '**') {
      if (walk(i, j + 1)) return true
      if (walk(i + 1, j)) return true
      return false
    }
    return segmentsIntersect(head, other) && walk(i + 1, j + 1)
  }

  return walk(0, 0)
}

/** True if any file could be matched by both patterns. */
export function globsIntersect(a: string, b: string): boolean {
  const aVariants = expandBraces(a).map(toSegments)
  const bVariants = expandBraces(b).map(toSegments)
  return aVariants.some((av) => bVariants.some((bv) => segmentListsIntersect(av, bv)))
}

/** True if any glob in `a` overlaps any glob in `b`. */
export function globSetsIntersect(a: string[], b: string[]): string[] | null {
  for (const left of a) {
    for (const right of b) {
      if (globsIntersect(left, right)) return [left, right]
    }
  }
  return null
}

/** Does a concrete file path fall under any of these globs? Used by the lease gate. */
export function pathMatchesAny(filePath: string, patterns: string[]): boolean {
  const target = normalizeGlob(filePath)
    .split('/')
    .filter((s) => s.length > 0)
  return patterns.some((pattern) =>
    expandBraces(pattern).some((variant) => pathMatchesSegments(target, toSegments(variant))),
  )
}

function pathMatchesSegments(path: string[], pattern: string[]): boolean {
  const walk = (i: number, j: number): boolean => {
    if (j >= pattern.length) return i >= path.length
    const head = pattern[j]!
    if (head === '**') {
      for (let k = i; k <= path.length; k++) if (walk(k, j + 1)) return true
      return false
    }
    if (i >= path.length) return false
    return matchesSegment(path[i]!, head) && walk(i + 1, j + 1)
  }
  return walk(0, 0)
}

function matchesSegment(name: string, pattern: string): boolean {
  if (pattern === '*') return true
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  )
  return regex.test(name)
}
