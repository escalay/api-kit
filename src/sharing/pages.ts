/**
 * The sign-in pages: what a person sees between their app and the grant. Every page is escaped, carries the app's brand
 * as the kit's own pages do, and is served never stored, never indexed, never framed, with no script, sending no
 * referrer to another origin, and posting only here or (through the kit's 302) to the client's return. A client's name
 * is its own claim, shown after `appNameOf`; where it returns is what the page warns of.
 *
 * @example
 * const pages = sharingPages({ brand, origin: 'https://sample.example.test' })
 * return pages.code(c, ask, { kind: 'unknown', host: 'evil-app:' })
 */
import type { Context } from 'hono'
import type { AgentBrand } from '../core/discovery.js'
import type { SignInAsk } from '../oauth/index.js'
import { appNameOf } from './grants.js'

/** The line on every page that approves: the grant goes to whichever account the app has in this browser. */
export const ACCOUNT_LINE = 'This connects the app signed in in this browser.'
const NOT_OURS = 'That code is not one of ours: check it against your invite.'
const START_AGAIN = 'start again from your app.'

/** Where a client returns, as a page names it: this computer (a loopback http redirect), one the app knows, or a host or scheme to warn of. */
export type Return = { kind: 'this-computer' } | { kind: 'known'; name: string } | { kind: 'unknown'; host: string }

/** What every page carries: the app's brand, and the origin its tags name. */
export type PageView = { brand?: AgentBrand; origin: string }

/** What a page says, and where its form's answer may send the browser besides here. */
type Page = { status: 200 | 400 | 403 | 429 | 503; title: string; body: string; returnsTo?: string; headers?: Record<string, string> }

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const STYLE = `:root{color-scheme:light dark;--bg:#fafaf9;--fg:#111;--muted:#ececeb;--mfg:#6b6b6b}@media(prefers-color-scheme:dark){:root{--bg:#0b0b0b;--fg:#f2f2f2;--muted:#1c1c1c;--mfg:#9a9a9a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{max-width:28rem;width:100%;background:var(--muted);border-radius:12px;padding:28px}h1{font-size:20px;font-weight:400;margin:0 0 8px}p{color:var(--mfg);margin:0 0 16px}
form{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}button,input{font:inherit;border-radius:8px;border:0;padding:10px 16px}button{background:var(--fg);color:var(--bg);cursor:pointer}
input{background:var(--bg);color:var(--fg);letter-spacing:.2em;width:12ch;text-align:center}`

/** The theme colour and the mark at the top, when the app has a brand. */
const brandParts = (brand: AgentBrand | undefined, origin: string) => {
  if (!brand) return { head: '', accent: '', mark: '' }
  const accent = brand.accent && /^#[0-9a-f]{6}$/i.test(brand.accent) ? `button{background:${brand.accent};color:#fff}` : ''
  const mark = `<header style="display:flex;align-items:center;gap:10px;margin:0 0 20px"><img src="/icon.svg" alt="" width="32" height="32"><span>${escape(brand.title)}</span></header>`
  return { head: brand.headTags(origin), accent, mark }
}

/** `form-action`: this origin, and the client's return (its origin, or its scheme), where the kit's 302 sends the browser. */
const formActionOf = (redirectUri: string | undefined) => {
  if (!redirectUri || !URL.canParse(redirectUri)) return "'self'"
  const url = new URL(redirectUri)
  const web = url.protocol === 'https:' || url.protocol === 'http:'
  return `'self' ${web ? url.origin : url.protocol}`
}

const send = (c: Context, { brand, origin }: PageView, page: Page) => {
  const { head, accent, mark } = brandParts(brand, origin)
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escape(page.title)}</title>${head}<style>${STYLE}${accent}</style></head><body><main>${mark}${page.body}</main></body></html>`
  return c.html(html, page.status, {
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action ${formActionOf(page.returnsTo)}`,
    ...page.headers,
  })
}

/** Where the client returns, in words: a warning for a return the app does not know. */
const returnLine = (back: Return) => {
  if (back.kind === 'this-computer') return '<p>It returns to an app on this computer.</p>'
  if (back.kind === 'known') return `<p>It returns to ${escape(back.name)}.</p>`
  return `<p><strong>This app returns to <code>${escape(back.host)}</code>.</strong> Join only if you know where that is: your code lets it in.</p>`
}

/** What the code page shows of a sign-in. */
type Asking = Pick<SignInAsk, 'ticket' | 'client' | 'redirectUri'>

/** The pages, for one app: its brand and origin. */
export const sharingPages = (view: PageView) => {
  /** Where an invite's code is typed; `note` says why it is shown again. */
  const code = (c: Context, ask: Asking, back: Return, note?: string) =>
    send(c, view, {
      status: note ? 400 : 200,
      title: 'Join with your invite',
      returnsTo: ask.redirectUri,
      body: `<h1>Join with your invite</h1>${returnLine(back)}<p>The app calls itself <strong>${escape(appNameOf(ask.client.name))}</strong>.</p>${note ? `<p role="alert"><strong>${escape(note)}</strong></p>` : ''}<p>Type the code from your invite.</p>
<form method="post" action="/sharing/join"><input type="hidden" name="ticket" value="${escape(ask.ticket)}"><input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" required aria-label="Invite code"><button>Join</button></form><p>${ACCOUNT_LINE}</p>`,
    })

  return {
    code,
    /** A wrong code: the code page again, the ticket still live. */
    wrongCode: (c: Context, ask: Asking, back: Return) => code(c, ask, back, NOT_OURS),
    /** A client that named the owner's whole app: no invite reaches it, and no form. */
    wrongAddress: (c: Context, status: 200 | 400) =>
      send(c, view, { status, title: 'Use the invite’s address', body: '<h1>Use the address in your invite</h1><p>This app connected to the owner\'s address: connect it to the address in your invite instead. Your invite\'s link shows it.</p>' }),
    /** A ticket this browser can't use: answered already, expired, or opened in another browser. */
    gone: (c: Context, outcome: 'approved' | 'denied' | 'answered' | null) => {
      if (outcome === 'approved' || outcome === 'answered') return send(c, view, { status: 400, title: 'Already joined', body: '<h1>Already joined</h1><p>This sign-in went through already: return to your app. You can close this page.</p>' })
      if (outcome === 'denied') return send(c, view, { status: 400, title: 'Refused', body: `<h1>This sign-in was refused</h1><p>Too many wrong codes, or a no: ${START_AGAIN}</p>` })
      return send(c, view, { status: 400, title: 'Expired', body: `<h1>This sign-in expired</h1><p>It ran out of time, or it was opened in another browser: ${START_AGAIN}</p>` })
    },
    /** A post from another site, or a sign-in these pages don't approve. */
    notAllowed: (c: Context) => send(c, view, { status: 403, title: 'Not allowed', body: '<h1>Not allowed</h1><p>Join from the page this site showed you, in the browser that opened it.</p>' }),
    /** Past a limit on typed codes. */
    tooMany: (c: Context, retry: number) =>
      send(c, view, { status: 429, title: 'Too many codes', body: `<h1>Too many codes</h1><p>Too many codes were typed from here or for this address: wait ${retry} seconds, then go back and try again.</p>`, headers: { 'retry-after': String(retry) } }),
    /** An app that asks only to make changes, at an invite that lets it read. */
    tooLittle: (c: Context, ask: Asking, back: Return) => code(c, ask, back, 'This app asks only to make changes, and this invite lets it read: ask the owner for one that allows changes.'),
    /** Before `registerSharing` binds the part. */
    notReady: (c: Context) => send(c, view, { status: 503, title: 'Not ready', body: '<h1>Sharing is not ready here yet</h1><p>Try again in a minute.</p>' }),
  }
}

export type SharingPages = ReturnType<typeof sharingPages>
