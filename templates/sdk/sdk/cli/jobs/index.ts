/**
 * The app's jobs: one task, one command, listed first by `__bin__` alone. Add one when the agent test shows agents
 * making the same few calls for one playbook step: a file here with `defineJob`, listed below, then `pnpm sdk:types`.
 *
 * @example
 * import { signup } from './signup.js'
 * export const jobs: Job[] = [signup]
 */
import type { Job } from '../engine/job.js'

export const jobs: Job[] = []
