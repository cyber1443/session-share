/**
 * Answers one question: does the committed bundle match the source in this
 * working tree? Run by the pre-push hook, because pushing a stale bundle is the
 * one version of this mistake that reaches someone else.
 *
 *   node scripts/check-bundle.mjs          exit 1 if stale
 *   node scripts/check-bundle.mjs --quiet  same, without the explanation
 */
import { computeHash, readStamp } from './bundle-hash.mjs'

const quiet = process.argv.includes('--quiet')
const expected = computeHash()
const actual = readStamp()

if (actual === expected) {
  if (!quiet) console.log('bundle is up to date')
  process.exit(0)
}

if (!quiet) {
  console.error(
    actual === null
      ? '\nThe plugin bundle has never been built.\n'
      : '\nThe plugin bundle is out of date with the source in this tree.\n',
  )
  console.error('Teammates install the committed bundle, so a stale one ships broken code.\n')
  console.error('  pnpm bundle && git add packages/plugin/bundle && git commit\n')
}

process.exit(1)
