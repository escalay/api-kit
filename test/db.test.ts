import { mkdtemp } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from '@hono/zod-openapi'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { boardsRepo, registerBoards } from '../src/boards/index.js'
import { createAgentApi, dbOAuthStore, hashApiKey, LinksSchema, migrate, openDb, parseApiKeys, testDb } from '../src/index.js'

const stateFile = async () => join(await mkdtemp(join(tmpdir(), 'kit-db-')), 'state.sqlite')
const later = () => Math.floor(Date.now() / 1000) + 3600

describe('the database', () => {
  it('adopts a state.sqlite written before Drizzle: boards, notes and OAuth rows survive', async () => {
    const file = await stateFile()
    // What every app's state held under kit 0.10: the tables made by hand, rows already in them
    const old = new DatabaseSync(file)
    old.exec(`create table boards (id text primary key, name text not null, description text, created_at text not null, updated_at text not null);
create table board_items (board_id text not null references boards(id) on delete cascade, ref text not null, note text, added_at text not null, primary key (board_id, ref));
create index board_items_ref on board_items(ref);
create table oauth (kind text not null, id text not null, value text not null, expires_at integer not null, primary key (kind, id));
insert into boards values ('b1', 'Saved', null, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
insert into board_items values ('b1', 'logo:fox', 'the tail', '2026-11-02T00:00:00.000Z');
insert into oauth values ('client', 'c1', '{"name":"Claude"}', ${later()});`)
    old.close()

    const db = await openDb(`file:${file}`)
    const app = createAgentApi({ title: 'Logos', version: '1.0.0', description: 'Logos.', tags: [{ name: 'Boards', description: 'Collections.' }], auth: { realm: 'logos', keys: parseApiKeys(`agent:${hashApiKey('k')}`) } })
    await registerBoards(app, { db, item: z.object({ slug: z.string(), _links: LinksSchema }).openapi('Card', { description: 'A logo.' }), refExample: 'logo:fox', itemOf: (ref) => ({ slug: ref.slice(5), _links: {} }) })
    const store = await dbOAuthStore(db)

    const board = await (await app.request('/api/boards/b1', { headers: { authorization: 'Bearer k' } })).json()
    expect(board).toMatchObject({ id: 'b1', name: 'Saved', items: 1, _embedded: { items: [{ ref: 'logo:fox', note: 'the tail' }] } })
    expect(await store.get('client', 'c1')).toEqual({ name: 'Claude' })
    expect(await db.all(sql`select feature, step from kit_migrations order by feature`)).toEqual([['boards', 1], ['oauth', 1]])
  })

  it('opens a file, memory or an open database, and names what it can’t open', async () => {
    const file = await stateFile()
    await (await openDb(file)).run(sql`create table t (id integer)`)
    expect(await (await openDb(`file:${file}`)).all(sql`select name from sqlite_master where name = 't'`)).toEqual([['t']])
    expect(await (await openDb(new DatabaseSync(file))).all(sql`select count(*) from t`)).toEqual([[0]])
    const made = await testDb()
    expect(await openDb(made)).toBe(made)
    await expect(openDb('libsql://example.turso.io')).rejects.toThrow('open it with its Drizzle driver')
  })

  it('applies each migration step once, in order, and records it', async () => {
    const db = await testDb()
    const steps = ['create table notes (id text primary key)', 'alter table notes add column body text; create index notes_body on notes(body)']
    await migrate(db, 'notes', steps.slice(0, 1))
    await migrate(db, 'notes', steps)
    await migrate(db, 'notes', steps)
    await db.run(sql`insert into notes (id, body) values ('n1', 'hello')`)
    expect(await db.all(sql`select id, body from notes`)).toEqual([['n1', 'hello']])
    expect(await db.all(sql`select step from kit_migrations where feature = 'notes'`)).toEqual([[1], [2]])
  })

  it('rolls a failing step back whole, so it runs again next start', async () => {
    const db = await testDb()
    await expect(migrate(db, 'broken', ['create table a (id text); create table a (id text)'])).rejects.toThrow()
    expect(await db.all(sql`select name from sqlite_master where name = 'a'`)).toEqual([])
    expect(await db.all(sql`select step from kit_migrations where feature = 'broken'`)).toEqual([])
  })

  it('keeps columns with the same name apart in a join', async () => {
    const db = await testDb()
    const repo = boardsRepo(db)
    await migrate(db, 'boards', (await import('../src/boards/index.js')).BOARDS_MIGRATIONS)
    const id = await repo.create({ name: 'Join', description: null })
    await repo.save(id, 'logo:fox', 'n')
    expect(await db.all(sql`select b.id, i.ref, b.name from boards b join board_items i on i.board_id = b.id`)).toEqual([[id, 'logo:fox', 'Join']])
    expect((await repo.list('logo:fox')).map((row) => [row.name, row.items])).toEqual([['Join', 1]])
  })
})
