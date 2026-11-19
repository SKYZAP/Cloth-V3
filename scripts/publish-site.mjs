// Publish the cloth.dev site: push website/ (as committed on this branch) to the public SKYZAP/cloth.dev
// repository, whose own workflow deploys it to GitHub Pages. Cloth-V3 stays private.
//   npm run site:publish
import { execFileSync } from 'node:child_process'

const REMOTE = 'https://github.com/SKYZAP/cloth.dev.git'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()

if (git('status', '--porcelain', '--', 'website')) {
  console.error('website/ has uncommitted changes. Commit them first: only committed files are published.')
  process.exit(1)
}
// The site's history: one commit per commit that changed website/, with website/ as the root.
const commit = git('subtree', 'split', '--prefix', 'website')
console.log(`Publishing ${commit.slice(0, 7)} to ${REMOTE}`)
execFileSync('git', ['push', REMOTE, `${commit}:refs/heads/main`], { stdio: 'inherit' })
console.log('Pushed. GitHub Pages deploys it in a minute or two: https://github.com/SKYZAP/cloth.dev/actions')
