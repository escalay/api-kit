/**
 * Points git at .githooks, so `git push` runs `pnpm gate` first. Runs on `pnpm install` (the `prepare` script), and
 * only when this folder is the repository's root: an app inside a larger repository leaves that repository's hooks alone.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

try {
  if (realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(process.cwd())) git('config', 'core.hooksPath', '.githooks')
} catch {
  // Not a git repository yet, or no git: nothing to point
}
