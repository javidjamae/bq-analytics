#!/usr/bin/env node
/**
 * Cut a release.
 *
 *   npm run release -- patch|minor|major|1.2.3
 *
 * Consumers install this package from a git URL, so the git TAG is the version
 * — package.json alone changes nothing for them. This script keeps
 * package.json, src/version.ts, the CHANGELOG, and the tag in agreement, which
 * is the whole point: a moved tag or a hand-edited version is how a consumer
 * ends up running code nobody can identify.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args, opts = {}) => {
  // With stdio: 'inherit' execFileSync returns null, not a string.
  const out = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
  return out === null ? '' : out.trim()
}

const bump = process.argv[2]
if (!bump) {
  console.error('usage: npm run release -- patch|minor|major|<x.y.z>')
  process.exit(64)
}

if (run('git', ['status', '--porcelain'])) {
  console.error('working tree is dirty — commit or stash first')
  process.exit(1)
}

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)

const next =
  bump === 'major' ? `${major + 1}.0.0`
  : bump === 'minor' ? `${major}.${minor + 1}.0`
  : bump === 'patch' ? `${major}.${minor}.${patch + 1}`
  : bump

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`not a semver version: ${next}`)
  process.exit(64)
}

// package.json
pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// src/version.ts — asserted against package.json by the test suite
const versionPath = join(root, 'src/version.ts')
const versionSrc = readFileSync(versionPath, 'utf8')
writeFileSync(versionPath, versionSrc.replace(/VERSION = '[^']*'/, `VERSION = '${next}'`))

// CHANGELOG — promote Unreleased to the new version
const changelogPath = join(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
const today = new Date().toISOString().slice(0, 10)
if (!changelog.includes('## Unreleased')) {
  console.error('CHANGELOG.md has no "## Unreleased" section to promote')
  process.exit(1)
}
writeFileSync(
  changelogPath,
  changelog.replace('## Unreleased', `## Unreleased\n\n_Nothing yet._\n\n## ${next} — ${today}`)
)

console.log(`running tests before tagging ${next}…`)
run('npm', ['test'], { stdio: 'inherit' })

run('git', ['add', 'package.json', 'src/version.ts', 'CHANGELOG.md'])
run('git', ['commit', '-m', `release: v${next}`])
run('git', ['tag', '-a', `v${next}`, '-m', `v${next}`])

console.log(`
tagged v${next}. Publish it with:

  git push && git push --tags

Pushing the tag triggers .github/workflows/release.yml, which builds the
package and attaches the tarball to a GitHub Release. Consumers install that
asset, not the repository — a git dependency would try to compile itself at
install time and fail in any production-only install.

Once the workflow is green, consumers pin it with:

  "bq-analytics": "https://github.com/javidjamae/bq-analytics/releases/download/v${next}/bq-analytics-${next}.tgz"
`)
