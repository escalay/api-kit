/**
 * A suggested features UI over the `switches-react` hooks, as a shadcn block:
 *
 *   FeatureSwitches        every feature with its switch (owners) or its state (everyone else), what it needs, and a
 *                          confirm row naming what else stops before a feature goes off
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

/** A feature's state in a few words, beside its switch. */
const stateLine = (feature: FeatureView, why: string) => {
  if (feature.locked) return 'Off in the deployment’s settings'
  if (!feature.on) return why
  return feature.source === 'default' ? 'On' : `On${feature.scope && feature.scope !== 'everyone' ? ' for you' : ''}`
}

/**
 * Every feature with its switch. Switching one off first asks what else stops and shows it in a confirm row; switching
 * on happens at once. Without `canSwitch` the switches are read-only and say who can change them.
 *
 * @example
 * <FeatureSwitches canSwitch={isOwner} className="max-w-xl" />
 */
export const FeatureSwitches = ({ canSwitch = false, className, describe }: { canSwitch?: boolean; className?: string; describe?: (feature: FeatureView) => ReactNode }) => {
  const { features, status, error } = useFeatures()
  const { preview, apply, pending } = useSwitchFeature()
  const [confirming, setConfirming] = useState<Pending | null>(null)
  const list = Object.values(features) as FeatureView[]
  const titleOf = (key: string) => (features[key] as FeatureView | undefined)?.title ?? key

  const flip = async (feature: FeatureView, on: boolean) => {
    if (on) return void (await apply(feature.key, true).catch(() => undefined))
    const changes = await preview(feature.key, false).catch(() => null)
    if (changes) setConfirming({ key: feature.key, changes })
  }

  if (status === 'loading') return <p className={cn('text-sm text-muted-foreground', className)}>Loading features…</p>
  if (status === 'error') return <p className={cn('text-sm text-destructive', className)}>{error?.message ?? 'The features could not be loaded.'}</p>
  return (
    <ul className={cn('divide-y rounded-lg border', className)} aria-label="Features">
      {list.map((feature) => {
        const why = feature.on ? '' : feature.blockedBy.length ? `Needs ${feature.blockedBy.map(titleOf).join(', ')}` : 'Off'
        const asking = confirming?.key === feature.key ? confirming : null
        return (
          <li key={feature.key} className="grid gap-2 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-0.5">
                <span className="font-medium">{feature.title}</span>
                <span className="text-sm text-muted-foreground">{describe?.(feature) ?? feature.description}</span>
                <span className="text-xs text-muted-foreground">{stateLine(feature, why)}</span>
              </div>
              <Switch
                checked={feature.own}
                disabled={!canSwitch || feature.locked || pending !== null}
                aria-label={`${feature.title}: ${feature.own ? 'on' : 'off'}`}
                onCheckedChange={(on) => void flip(feature, on)}
              />
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
      })}
      {!canSwitch && <li className="p-4 text-xs text-muted-foreground">Only an owner can switch features.</li>}
    </ul>
  )
}

/**
 * The notice for a screen whose feature is off: "This feature is disabled.", why, and the app's own `action`.
 *
 * @example
 * <FeatureDisabledNotice name="digest" action={<Button asChild><a href="/upgrade">Upgrade</a></Button>} />
 */
export const FeatureDisabledNotice = ({ name, action, className }: { name: string; action?: ReactNode; className?: string }) => {
  const { feature, why } = useFeature(name)
  return (
    <div role="status" className={cn('grid gap-2 rounded-lg border p-6 text-sm', className)}>
      <p className="font-medium">This feature is disabled.</p>
      {why && <p className="text-muted-foreground">{why}</p>}
      {feature && !feature.locked && <p className="text-muted-foreground">An owner can switch it on under Features.</p>}
      {action}
    </div>
  )
}
