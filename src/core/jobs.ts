/**
 * Work done later, at a chosen delay. Features ask "do this in five minutes"; only the app's entry point knows it is a
 * Cloudflare Queue (`queueJobs(env.JOBS)`). Tests use `memoryJobs` and run what was sent. A job runs once per message:
 * one that must be tried again sends itself again.
 */

export type Jobs<Job> = { send: (job: Job, options?: { delaySeconds?: number }) => Promise<void> }

/** The part of a Cloudflare Queue this uses (no Workers types needed). */
type Queue<Job> = { send: (body: Job, options?: { delaySeconds?: number }) => Promise<unknown> }

/** Queues allow a delay of 12 hours at most. */
export const MAX_DELAY_SECONDS = 43_200

/** queueJobs sends jobs to a Cloudflare Queue, the delay rounded and kept within what Queues allow. */
export const queueJobs = <Job>(queue: Queue<Job>): Jobs<Job> => ({
  send: async (job, { delaySeconds = 0 } = {}) => {
    await queue.send(job, { delaySeconds: Math.min(Math.max(0, Math.round(delaySeconds)), MAX_DELAY_SECONDS) })
  },
})

/** memoryJobs keeps what it is sent, for a test to run. */
export const memoryJobs = <Job>() => {
  const sent: { job: Job; delaySeconds: number }[] = []
  const jobs: Jobs<Job> & { sent: typeof sent } = {
    sent,
    send: async (job, { delaySeconds = 0 } = {}) => {
      sent.push({ job, delaySeconds })
    },
  }
  return jobs
}
