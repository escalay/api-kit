/** Long polling: a route that answers as soon as there is something, or after a few seconds with nothing. */

/** How often a wait looks again. */
export const POLL_MS = 500

/**
 * waitFor calls `look` until it finds something or `timeoutSeconds` pass, and returns what it found or undefined.
 * `0` looks once. Keep a route's wait under ~25 seconds: proxies and clients give up on longer requests.
 *
 * @example
 * const mail = await waitFor(() => repo.nextOn(addressId, { after }), timeout)
 */
export const waitFor = async <Found>(look: () => Promise<Found | undefined>, timeoutSeconds: number, pollMs = POLL_MS) => {
  const deadline = Date.now() + timeoutSeconds * 1000
  let found = await look()
  while (!found && Date.now() + pollMs <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    found = await look()
  }
  return found
}
