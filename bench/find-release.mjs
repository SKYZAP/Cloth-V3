// Which release tag to benchmark, for .github/workflows/bench.yml. Prints `tag=<tag>` (or `tag=` for none) to
// GITHUB_OUTPUT.
//   workflow_dispatch: INPUT_TAG, or the latest release.
//   workflow_run (the Release workflow finished): the release it was for. A release published on GitHub runs it on
//   the tag (HEAD_BRANCH); a manual Release run creates the release on its own commit (HEAD_SHA).
import { appendFileSync } from 'node:fs'

const { GITHUB_REPOSITORY: repo, GH_TOKEN: token, EVENT, INPUT_TAG, HEAD_BRANCH, HEAD_SHA } = process.env
const api = async (path) => {
  const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } })
  return r.ok ? r.json() : null
}

let tag = INPUT_TAG?.trim() || ''
if (!tag && EVENT === 'workflow_dispatch') tag = (await api('releases/latest'))?.tag_name ?? ''
if (!tag && EVENT === 'workflow_run') {
  if (/^v\d/.test(HEAD_BRANCH ?? '')) tag = HEAD_BRANCH
  else
    for (const r of (await api('releases?per_page=10')) ?? []) {
      if ((await api(`commits/${encodeURIComponent(r.tag_name)}`))?.sha === HEAD_SHA) {
        tag = r.tag_name
        break
      }
    }
}
if (tag && !(await api(`releases/tags/${encodeURIComponent(tag)}`))) {
  console.log(`::error::There is no release ${tag}`)
  process.exitCode = 1
} else {
  console.log(tag ? `Benchmarking ${tag}` : 'No release to benchmark')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`)
}
