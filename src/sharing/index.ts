/**
 * Sharing: invites to a space, asks to join and the owner's approval, on the oauth part's hooks (`approve`,
 * `complete`, `onGrant`, `onRevoke`, `accepts`). A **space** is the part of an app that is shared (a shelf, a board, a
 * project); a **member** is one grant into one space. So far the part holds its tables (`SHARING_MIGRATIONS`), the
 * only queries (`sharingRepo`), the named states of its rows (`states.ts`) and its secrets (`secrets.ts`); the routes,
 * pages and hooks come next (its README says what is there).
 *
 * @example
 * await migrate(db, 'sharing', SHARING_MIGRATIONS)
 * const repo = sharingRepo(db)
 * const keys = sharingKeys(env.SHARING_SECRET)
 */
export { sharingRepo, type InviteRow, type InviteWithMember, type MemberRow, type NewInvite, type NewMember, type NewRequest, type PageAt, type RequestRow, type RequestWithMember, type SharingRepo, type SpaceRow } from './repo.js'
export { sharingInvites, sharingMembers, sharingRequests, sharingSpaces, SHARING_MIGRATIONS, type EndedReason, type Lifetime, type Scope } from './schema.js'
export { addressKeyOf, CODE_ALPHABET, codeHashOf, linkHashOf, newInviteCode, newLinkToken, newShownCode, normalisedCode, sharingKeys, ticketHashOf, type SharingKeys } from './secrets.js'
export { askingStateOf, inviteStateOf, memberExpiresAtOf, memberListingOf, memberStateOf, redeemByOf, requestStateOf, REDEEM_WITHIN, UNANSWERED_PAUSE, UNSEEN_FOR, type AskingState, type InviteState, type MemberListing, type MemberState, type RequestState } from './states.js'
