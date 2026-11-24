/**
 * The app's hooks (`onKeyChange`, `onSwitch`, `onTeamChange`, `onPasskeyChange`, `onRecovery`) are told after the change
 * they report is made, so a hook that throws must not answer the request: the key is stored, the switch flipped.
 *
 * @example
 * await repo.create(row)
 * await tellApp('onKeyChange', () => onKeyChange?.({ id: row.id, name, action: 'created', by }, c))
 */

/**
 * tellApp calls one of the app's hooks after the change it reports is made; a throw is logged, never answered, so a
 * failing log can't turn a done change into a 500 (or spend a recovery for nothing).
 *
 * @example
 * await tellApp('onRecovery', () => onRecovery?.({ stage: 'started', who }, c))
 */
export const tellApp = async (hook: string, call: () => void | Promise<void>) => {
  try {
    await call()
  } catch (error) {
    console.error(`${hook} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
