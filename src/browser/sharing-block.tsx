/**
 * A suggested Share panel over the `sharing-react` hook, as a shadcn block:
 *
 *   SharePanel   one space as its owner sees it: make an invite, its code shown once, the invites out and the members
 *   InvitesOut   the invite form (the owner page's two choices: Allow changes, Until revoked) and the invites, newest
 *                first, each open one with Revoke
 *   Members      who joined, by the app's own words, each with Invite again and Remove (after asking)
 *
 * Install: `npx shadcn add escalay/api-kit/sharing-ui`, or `kit add sharing-ui --web-dir src/components/sharing`.
 * Needs the shadcn `button`, `input` and `switch`. Copy it, restyle it or skip it: the hook carries the logic.
 *
 * @example
 * const sharing = useMemo(() => createSharingClient({ path: '/api/shelves' }), [])
 * <SharePanel client={sharing} space="soups" />
 */
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ShownOnceError, type Invite, type Lifetime, type Member, type NewInvite, type Scope, type SharingClient } from './sharing-client'
import { useSharing } from './sharing-react'

/** What `useSharing` answers: the one space the parts of the panel share. */
export type OwnerSharing = ReturnType<typeof useSharing>

const SCOPE_WORDS: Record<Scope, string> = { read: 'Can read', write: 'Can read and make changes' }
const LIFETIME_WORDS: Record<Lifetime, string> = { '7d': 'for 7 days', '30d': 'for 30 days', until_revoked: 'until revoked' }
const INVITE_STATE_WORDS: Record<Invite['state'], string> = { open: 'Open', redeemed: 'Used', revoked: 'Revoked', expired: 'Expired' }
const MEMBER_STATE_WORDS: Record<Member['state'], string> = { active: 'Active', signed_out: 'Signed out' }
const SHOWN_ONCE = 'That invite was made, but its code cannot be shown again: revoke it and make another.'

/** A small label beside a row's name: its state. */
const BADGE = 'rounded-sm border px-1.5 py-px text-[0.65rem] font-medium tracking-wide uppercase text-muted-foreground'
const ALERT = 'text-sm text-destructive'

/** What an invite or a member may do, in words: "Can read, for 30 days". */
const accessLine = (scope: Scope, lifetime: Lifetime) => `${SCOPE_WORDS[scope]}, ${LIFETIME_WORDS[lifetime]}`

/** The grant the form's choices make, as the owner page says it. */
const grantLine = (title: string, scope: Scope, lifetime: Lifetime) => `Whoever uses it can ${scope === 'write' ? 'read and make changes to' : 'read'} ${title} ${LIFETIME_WORDS[lifetime]}.`

/** Why a change failed, in a sentence: a retried invite says its code is gone. */
const failureOf = (caught: unknown) => {
  if (caught instanceof ShownOnceError) return SHOWN_ONCE
  if (caught instanceof Error) return caught.message
  return 'The change failed.'
}

/**
 * Runs one change at a time: `pending` while it runs, its failure kept as a sentence until the next one starts.
 * Answers the change's result, or null when it failed.
 */
const useChange = () => {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = async <Result,>(change: () => Promise<Result>, onFailure?: (caught: unknown) => void) => {
    setPending(true)
    setFailure(null)
    try {
      return await change()
    } catch (caught) {
      onFailure?.(caught)
      setFailure(failureOf(caught))
      return null
    } finally {
      setPending(false)
    }
  }
  return { pending, failure, run }
}

/** The address and code to send, shown this once; Done drops them from the page. */
const ShownOnce = ({ invite, onDone }: { invite: NewInvite; onDone: () => void }) => (
  <section aria-label="Send this once" className="grid gap-2 rounded-lg border bg-muted/50 p-4 text-sm">
    <p className="font-medium">{`Send this to ${invite.label}. Its code is shown only this once.`}</p>
    <pre className="whitespace-pre-wrap break-words rounded-md bg-background p-3 font-mono text-xs">{invite.message}</pre>
    <span className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(invite.message).catch(() => undefined)}>
        Copy
      </Button>
      <Button size="sm" onClick={onDone}>
        Done
      </Button>
    </span>
  </section>
)

/** A "Show more" button for a list with another page. */
const ShowMore = ({ name, pending, onClick }: { name: string; pending: boolean; onClick: () => void }) => (
  <Button size="sm" variant="ghost" className="justify-self-start" disabled={pending} onClick={onClick}>
    {`Show more ${name}`}
  </Button>
)

/**
 * The invite form and the space's invites, newest first. The form offers what the owner page offers: read for 30
 * days, unless Allow changes or Until revoked is switched on. A new invite goes to `onShown`, the only place its code
 * is; a retry after a lost answer sends the same Idempotency-Key, so it never makes a second invite.
 *
 * @example
 * <InvitesOut sharing={useSharing(client, 'soups')} onShown={(invite) => setShown(invite)} />
 */
export const InvitesOut = ({ sharing, onShown, className }: { sharing: OwnerSharing; onShown: (invite: NewInvite) => void; className?: string }) => {
  const labelId = useId()
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<Scope>('read')
  const [lifetime, setLifetime] = useState<Lifetime>('30d')
  // Kept across a failed try, so a retry is the same invite; a new one once that key made one, or the form changed
  const [attempt, setAttempt] = useState<string | null>(null)
  const { pending, failure, run } = useChange()
  const title = sharing.sharing?.title ?? ''

  const edit = (change: () => void) => {
    setAttempt(null)
    change()
  }

  const make = async () => {
    const idempotencyKey = attempt ?? crypto.randomUUID()
    setAttempt(idempotencyKey)
    const forgetKeyIfSpent = (caught: unknown) => caught instanceof ShownOnceError && setAttempt(null)
    const invite = await run(() => sharing.createInvite({ label: label.trim(), scope, lifetime }, { idempotencyKey }), forgetKeyIfSpent)
    if (!invite) return
    setAttempt(null)
    setLabel('')
    onShown(invite)
  }

  return (
    <section aria-label="Invites" className={cn('grid gap-4', className)}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void make()
        }}
      >
        <label htmlFor={labelId} className="text-sm font-medium">
          Who it is for
        </label>
        <Input id={labelId} value={label} placeholder="Sam" onChange={(event) => edit(() => setLabel(event.target.value))} />
        <span className="flex items-center gap-2 text-sm">
          <Switch checked={scope === 'write'} aria-label="Allow changes" onCheckedChange={(on) => edit(() => setScope(on ? 'write' : 'read'))} />
          Allow changes
        </span>
        <span className="flex items-center gap-2 text-sm">
          <Switch checked={lifetime === 'until_revoked'} aria-label="Until revoked, not 30 days" onCheckedChange={(on) => edit(() => setLifetime(on ? 'until_revoked' : '30d'))} />
          Until revoked, not 30 days
        </span>
        <p className="text-sm text-muted-foreground">{grantLine(title, scope, lifetime)}</p>
        <Button type="submit" className="justify-self-start" disabled={pending || !label.trim()}>
          Make an invite
        </Button>
        {failure && (
          <p role="alert" className={ALERT}>
            {failure}
          </p>
        )}
      </form>
      <h3 className="font-medium">Invites out</h3>
      {sharing.invites.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invites yet.</p>
      ) : (
        <ul aria-label="Invites out" className="divide-y rounded-lg border px-4">
          {sharing.invites.map((invite) => (
            <li key={invite.id} className="flex items-center justify-between gap-4 py-3">
              <span className="grid min-w-0 gap-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  <span>{invite.label}</span>
                  <span className={BADGE}>{INVITE_STATE_WORDS[invite.state]}</span>
                </span>
                <span className="text-sm text-muted-foreground">{accessLine(invite.scope, invite.lifetime)}</span>
              </span>
              {invite.state === 'open' && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(() => sharing.revokeInvite(invite.id))}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sharing.moreInvites && <ShowMore name="invites" pending={pending} onClick={() => void run(sharing.loadMoreInvites)} />}
    </section>
  )
}

/**
 * The space's members, newest first: the app's name and where it returns are its own claim, shown as text. Invite
 * again makes a fresh invite with the member's label, scope and lifetime (to `onShown`); Remove asks first, then ends
 * the member's sign-in at once.
 *
 * @example
 * <Members sharing={useSharing(client, 'soups')} onShown={(invite) => setShown(invite)} />
 */
export const Members = ({ sharing, onShown, className }: { sharing: OwnerSharing; onShown: (invite: NewInvite) => void; className?: string }) => {
  const [confirming, setConfirming] = useState<string | null>(null)
  const { pending, failure, run } = useChange()

  const inviteAgain = async (member: Member) => {
    const invite = await run(() => sharing.inviteAgain(member.id, { idempotencyKey: crypto.randomUUID() }))
    if (invite) onShown(invite)
  }

  const remove = async (member: Member) => {
    await run(() => sharing.removeMember(member.id))
    setConfirming(null)
  }

  return (
    <section aria-label="People" className={cn('grid gap-4', className)}>
      <h3 className="font-medium">Members</h3>
      {failure && (
        <p role="alert" className={ALERT}>
          {failure}
        </p>
      )}
      {sharing.members.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody has joined yet.</p>
      ) : (
        <ul aria-label="Members" className="divide-y rounded-lg border px-4">
          {sharing.members.map((member) => (
            <li key={member.id} className="grid gap-2 py-3">
              <div className="flex items-center justify-between gap-4">
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    <span>{member.label}</span>
                    <span className={BADGE}>{MEMBER_STATE_WORDS[member.state]}</span>
                  </span>
                  <span className="truncate text-sm text-muted-foreground">{`${member.appName}, returns to ${member.returnsTo}`}</span>
                  <span className="text-xs text-muted-foreground">{accessLine(member.scope, member.lifetime)}</span>
                </span>
                <span className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => void inviteAgain(member)}>
                    Invite again
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(member.id)}>
                    Remove
                  </Button>
                </span>
              </div>
              {confirming === member.id && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3 text-sm">
                  <span>{`Remove ${member.label}? Their app stops working at once.`}</span>
                  <span className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                    <Button size="sm" variant="destructive" disabled={pending} onClick={() => void remove(member)}>
                      Remove
                    </Button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {sharing.moreMembers && <ShowMore name="members" pending={pending} onClick={() => void run(sharing.loadMoreMembers)} />}
    </section>
  )
}

/** One space's panel; `SharePanel` keys it by space, so nothing shown for one space stays for the next. */
const SharePanelAt = ({ client, space, limit, className }: { client: SharingClient; space: string; limit?: number; className?: string }) => {
  const sharing = useSharing(client, space, { limit })
  const [shown, setShown] = useState<NewInvite | null>(null)

  if (!sharing.sharing && sharing.status === 'error') {
    return (
      <p role="alert" className={cn(ALERT, className)}>
        {sharing.error?.detail ?? 'This space’s sharing could not be loaded.'}
      </p>
    )
  }
  if (!sharing.sharing) return <p className={cn('text-sm text-muted-foreground', className)}>Loading…</p>
  return (
    <div className={cn('grid gap-6', className)}>
      <h2 className="text-lg font-semibold">{`Share ${sharing.sharing.title}`}</h2>
      {sharing.status === 'error' && <p className="text-sm text-muted-foreground">{`Not up to date: ${sharing.error?.detail ?? 'the last load failed.'}`}</p>}
      {shown && <ShownOnce invite={shown} onDone={() => setShown(null)} />}
      <InvitesOut sharing={sharing} onShown={setShown} />
      <Members sharing={sharing} onShown={setShown} />
    </div>
  )
}

/**
 * The owner's Share panel for one space: the invite form, the code of a new invite shown once (until Done, or another
 * space), the invites out and the members, each list a page at a time. Changes fail as a line saying why; nothing is
 * kept in storage. Without `space` it shows nothing.
 *
 * @example
 * <SharePanel client={sharing} space={shelf.name} limit={20} />
 */
export const SharePanel = ({ client, space, limit, className }: { client: SharingClient; space: string | null | undefined; limit?: number; className?: string }) => {
  if (!space) return null
  return <SharePanelAt key={space} client={client} space={space} limit={limit} className={className} />
}
