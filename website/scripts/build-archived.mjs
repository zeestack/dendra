// Builds the archived docs listed in versions.json into out/<path>/, after the
// current docs are built into out/. Each one is the website as it was at `ref`
// (the last release of that major), built from a git worktree with this
// versions.json, so every version's switcher lists every other.
//
// To archive a major when the next one ships (e.g. 2.0):
//   add { "label": "1.x", "path": "v1", "ref": "v1.9.3" } to versions.json.
// `ref` must be a tag or commit whose website has docs-version.mjs (1.0 or later).
//
//   node scripts/build-archived.mjs   (from website/, after `npm run build`)

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const website = fileURLToPath(new URL('..', import.meta.url))
const out = join(website, 'out')
const { archived } = JSON.parse(readFileSync(join(website, 'versions.json'), 'utf8'))
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })

if (!existsSync(out)) throw new Error('Build the current docs first (npm run build).')

for (const { label, path, ref } of archived) {
  const tree = mkdtempSync(join(tmpdir(), `dendra-docs-${path}-`))
  console.log(`\nArchived docs ${label}: ${ref} → out/${path}/`)
  run('git', ['worktree', 'add', '--detach', tree, ref], { cwd: website })
  try {
    const site = join(tree, 'website')
    cpSync(join(website, 'versions.json'), join(site, 'versions.json'))
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: site })
    run('npx', ['next', 'build'], {
      cwd: site,
      env: { ...process.env, DOCS_ARCHIVED: '1', DOCS_BASE_PATH: `/dendra/${path}` }
    })
    cpSync(join(site, 'out'), join(out, path), { recursive: true })
  } finally {
    run('git', ['worktree', 'remove', '--force', tree], { cwd: website })
    rmSync(tree, { recursive: true, force: true })
  }
}
