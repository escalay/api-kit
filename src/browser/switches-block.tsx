/**
 * A suggested features UI over the `switches-react` hooks, as a shadcn block:
 *
 *   FeatureSwitches        every feature with its switch (owners) or its state (everyone else), in cards by group,
 *                          with icons and plan badges, and a confirm row naming what else stops before one goes off
 *   FeatureDisabledNotice  "This feature is disabled." with why, for a screen whose feature is off; `action` takes a
 *                          button of the app's own (ask the owner, upgrade, sign up)
 *
 * Install: `npx shadcn add escalay/api-kit/switches-ui`, or `kit add switches-ui --web-dir src/components/features`.
 * Needs the shadcn `button` and `switch`. Copy it, restyle it or skip it: the hooks carry the logic.
 *
 * @example
 * <FeatureSwitches canSwitch={me.role === 'owner'} />
 * <Feature name="digest" off={<FeatureDisabledNotice name="digest" action={<Button>Ask the owner</Button>} />}><Digest /></Feature>
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { FeatureChange, FeatureView } from './switches-client'
import { useFeature, useFeatures, useSwitchFeature } from './switches-react'

type Pending = { key: string; changes: FeatureChange[] }

/** A link that reads as a small action, with no component of its own (shadcn's Radix and Base UI buttons differ here). */
const UPGRADE_LINK = 'text-sm font-medium text-primary underline-offset-4 hover:underline'

/**
 * What the switch beside a feature cannot show, in a few words; empty when the switch says it all (on or off for
 * everyone, as set).
 */
const stateLine = (feature: FeatureView, why: string) => {
  if (feature.locked) return 'Off in the deployment’s settings'
  if (feature.licensed === false) return `Needs a license granting ${feature.requires}`
  if (feature.own && !feature.on) return why
  if (feature.scope && feature.scope !== 'everyone') return `${feature.own ? 'On' : 'Off'} for you`
  if (!feature.own && feature.changedBy) return `Switched off by ${feature.changedBy}`
  return ''
}

/** How many people or keys have a switch of their own for a feature, in words. */
const exceptionsLine = (count: number) => `Also switched for ${count} ${count === 1 ? 'person or key' : 'people or keys'} on their own, through the API`

/** A group of features in the panel: its own card, with a title and what the group is for. */
export type FeatureGroup = { title: string; description?: string; keys: readonly string[] }

/** A small label beside a feature's title, e.g. the plan it needs. */
const BADGE = 'rounded-sm border px-1.5 py-px text-[0.65rem] font-medium tracking-wide uppercase text-muted-foreground'

/** The features of one group that a license does not grant, as a sentence: "Audit export is available with enterprise". */
const lockedLine = (locked: FeatureView[]) => {
  const plans = [...new Set(locked.map((feature) => feature.requires))].join(' or ')
  const names = locked.map((feature) => feature.title)
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return `${listed} ${names.length > 1 ? 'are' : 'is'} available with ${plans}`
}

/**
 * Every feature with its switch (for everyone), in cards. Switching one off first asks what else stops and shows it
 * in a confirm row; switching on happens at once. Without `canSwitch` the switches are read-only and say who can
 * change them.
 *
 * - `groups` puts features in named cards, each with what it is for; a feature that needs one shown above it in the
 *   same card sits indented under it. `keys` is one card without a title. Neither: every feature, one card.
 * - `iconOf` gives a feature its icon tile.
 * - A paid feature carries its plan as a badge; a card with features the license does not grant opens with one line
 *   saying so and where to get them.
 * - An owner sees a quiet line when some person or key has a switch of their own.
 *
 * @example
 * <FeatureSwitches canSwitch={isOwner} iconOf={(key) => ICONS[key]} groups={[{ title: 'Mail out', description: 'Sending, and what sends.', keys: ['sending', 'relay'] }]} />
 */
export const FeatureSwitches = ({
  canSwitch = false,
  className,
  describe,
  keys,
  groups,
  iconOf,
}: {
  canSwitch?: boolean
  className?: string
  describe?: (feature: FeatureView) => ReactNode
  keys?: readonly string[]
  groups?: readonly FeatureGroup[]
  iconOf?: (key: string) => ReactNode
}) => {
  const { features, status, error, license } = useFeatures()
  const { preview, apply, pending } = useSwitchFeature()
  const [confirming, setConfirming] = useState<Pending | null>(null)
  const viewsOf = (wanted: readonly string[]) => wanted.map((key) => features[key]).filter((feature) => feature !== undefined) as FeatureView[]
  const cards: { group?: FeatureGroup; list: FeatureView[] }[] = groups ? groups.map((group) => ({ group, list: viewsOf(group.keys) })) : [{ list: keys ? viewsOf(keys) : (Object.values(features) as FeatureView[]) }]
  const titleOf = (key: string) => (features[key] as FeatureView | undefined)?.title ?? key

  const flip = async (feature: FeatureView, on: boolean) => {
    if (on) return void (await apply(feature.key, true).catch(() => undefined))
    const changes = await preview(feature.key, false).catch(() => null)
    if (changes) setConfirming({ key: feature.key, changes })
  }

  const row = (feature: FeatureView, nested: boolean) => {
    const why = feature.on ? '' : feature.blockedBy.length ? `Needs ${feature.blockedBy.map(titleOf).join(', ')}` : 'Off'
    const asking = confirming?.key === feature.key ? confirming : null
    const exceptions = feature.overrides.filter((override) => override.scope !== 'everyone').length
    const icon = iconOf?.(feature.key)
    return (
      <li key={feature.key} className={cn('grid gap-2 py-4', nested && 'ml-4 border-l pl-4')}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground [&_svg]:size-4">
                {icon}
              </span>
            )}
            <div className="grid min-w-0 gap-0.5">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {feature.title}
                {feature.requires && <span className={BADGE}>{feature.requires}</span>}
              </span>
              <span className="text-sm text-muted-foreground">{describe?.(feature) ?? feature.description}</span>
              {stateLine(feature, why) && <span className="text-xs text-muted-foreground">{stateLine(feature, why)}</span>}
              {canSwitch && exceptions > 0 && <span className="text-xs text-muted-foreground">{exceptionsLine(exceptions)}</span>}
            </div>
          </div>
          {feature.licensed === false && license?.upgrade ? (
            <a href={license.upgrade} className={cn(UPGRADE_LINK, 'shrink-0')}>
              Get {feature.requires}
            </a>
          ) : (
            <Switch
              checked={feature.own}
              disabled={!canSwitch || feature.locked || feature.licensed === false || pending !== null}
              aria-label={`${feature.title}: ${feature.own ? 'on' : 'off'}`}
              onCheckedChange={(on) => void flip(feature, on)}
            />
          )}
        </div>
        {asking && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3 text-sm">
            <span>
              Switching off {feature.title}
              {asking.changes.length > 1 ? ` also stops ${asking.changes.filter((change) => change.key !== feature.key).map((change) => titleOf(change.key)).join(', ')}` : ''}.
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Keep it on
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void apply(feature.key, false).then(() => setConfirming(null), () => undefined)}>
                Switch off
              </Button>
            </span>
          </div>
        )}
      </li>
    )
  }

  if (status === 'loading') return <p className={cn('text-sm text-muted-foreground', className)}>Loading features…</p>
  if (status === 'error') return <p className={cn('text-sm text-destructive', className)}>{error?.message ?? 'The features could not be loaded.'}</p>
  return (
    <div className={cn('grid gap-6', className)}>
      {cards.map(({ group, list }, index) => {
        const shown = new Set<string>()
        const locked = list.filter((feature) => feature.licensed === false)
        return (
          <section key={group?.title ?? index} aria-label={group?.title ?? 'Features'} className="rounded-lg border bg-card">
            {group && (
              <header className="grid gap-0.5 border-b px-5 py-4">
                <h3 className="font-medium">{group.title}</h3>
                {group.description && <p className="text-sm text-muted-foreground">{group.description}</p>}
              </header>
            )}
            {group && locked.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-5 py-3 text-sm">
                <span>{lockedLine(locked)}.</span>
                {license?.upgrade && (
                  <a href={license.upgrade} className={UPGRADE_LINK}>
                    Upgrade
                  </a>
                )}
              </div>
            )}
            <ul className="divide-y px-5" aria-label={group?.title ?? 'Features'}>
              {list.map((feature) => {
                const nested = feature.needs.some((need) => shown.has(need))
                shown.add(feature.key)
                return row(feature, nested)
              })}
            </ul>
          </section>
        )
      })}
      {!canSwitch && <p className="text-xs text-muted-foreground">Only an owner can switch features.</p>}
    </div>
  )
}

/**
 * The notice for a screen whose feature is off: "This feature is disabled.", why, and the app's own `action` (a link
 * to where its owner switches features, an upgrade, a sign-up); it names no page of its own.
 *
 * @example
 * <FeatureDisabledNotice name="digest" action={<Button asChild><a href="/upgrade">Upgrade</a></Button>} />
 */
export const FeatureDisabledNotice = ({ name, action, className }: { name: string; action?: ReactNode; className?: string }) => {
  const { feature, why } = useFeature(name)
  const { license } = useFeatures()
  const unlicensed = feature?.licensed === false
  return (
    <div role="status" className={cn('grid gap-2 rounded-lg border p-6 text-sm', className)}>
      <p className="font-medium">This feature is disabled.</p>
      {why && <p className="text-muted-foreground">{why}</p>}
      {feature && !feature.locked && !unlicensed && <p className="text-muted-foreground">An owner can switch it on.</p>}
      {action ??
        (unlicensed && license?.upgrade && (
          <a href={license.upgrade} className={cn(UPGRADE_LINK, 'justify-self-start')}>
            Get a license
          </a>
        ))}
    </div>
  )
}
