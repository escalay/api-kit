/** A passkey's default name: the device and browser it was made in, numbered when that name is taken. */

/** Devices a user agent names, most specific first. @example 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' */
const DEVICES: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

/** Browsers a user agent names, the ones built on another first. @example '… Chrome/131.0 Safari/537.36 Edg/131.0' */
const BROWSERS: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

/** The bare device words a client may post as a name: they say less than the user agent does. */
const BARE_NAMES = new Set(['', 'This device', ...DEVICES.map(([, device]) => device)])

const firstOf = (table: [RegExp, string][], agent: string) => table.find(([pattern]) => pattern.test(agent))?.[1]

/**
 * What to call a new passkey: the name the client gave, unless it is empty or only a bare device word; then
 * "device · browser" from the user agent.
 *
 * @example
 * passkeyBaseName('Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Chrome/131.0.0.0 Safari/537.36') // 'Mac · Chrome'
 * passkeyBaseName('Work laptop', anything) // 'Work laptop'
 */
export const passkeyBaseName = (asked: string | null | undefined, agent: string | null | undefined) => {
  const given = asked?.trim() ?? ''
  if (!BARE_NAMES.has(given)) return given
  const device = agent ? firstOf(DEVICES, agent) : undefined
  const browser = agent ? firstOf(BROWSERS, agent) : undefined
  return [device ?? (given || undefined), browser].filter(Boolean).join(' · ') || 'Passkey'
}

/** The name with " (2)", " (3)"… until none of `taken` has it. @example distinctName('Mac · Chrome', ['Mac · Chrome']) // 'Mac · Chrome (2)' */
export const distinctName = (base: string, taken: readonly (string | null)[]) => {
  const names = new Set(taken)
  let name = base
  for (let n = 2; names.has(name); n++) name = `${base} (${n})`
  return name
}
