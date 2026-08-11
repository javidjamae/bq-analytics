/**
 * Kept in lockstep with package.json by `npm run release`; a test fails if the
 * two ever drift. Consumers pin a git tag, so this is the value that tells you
 * what is actually deployed when a tag gets moved or a branch is installed.
 */
export const VERSION = '0.3.0'
