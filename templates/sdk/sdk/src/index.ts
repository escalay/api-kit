/**
 * A typed client for __Title__. It takes the address of one deployment and a key, and needs nothing but `fetch`.
 * Types come from the API's own OpenAPI document (`pnpm sdk:types` writes `schema.gen.ts`); this file names the calls.
 * `kit sdk` wrote one method per operation, named by its operationId; reshape them into what callers think in (a
 * handle per resource, a wait that loops), and give every new route a method, or the coverage test in `sdk/test` fails.
 *
 * @example
 * const __camel__ = create__Pascal__({ baseUrl: 'https://api.example.com', apiKey: process.env.API_KEY })
 * console.log(await __camel__.getHealth())
 */
import { createRequest, type ClientOptions } from './client.js'
import type { components, operations } from './schema.gen.js'

export { __Pascal__Error, type ClientOptions, type Problem } from './client.js'

export type Schemas = components['schemas']
type Content<Part> = Part extends { content: infer Types } ? Types[keyof Types] : undefined
/** What an operation answers when it succeeds. */
export type Answer<Id extends keyof operations> = Content<operations[Id]['responses'][keyof operations[Id]['responses'] & (200 | 201 | 202)]>
/** What an operation takes as its JSON body. */
export type Body<Id extends keyof operations> = Content<NonNullable<operations[Id]['requestBody']>>
/** What an operation takes in its query string. */
export type Query<Id extends keyof operations> = NonNullable<operations[Id]['parameters']['query']>

const segment = (value: string) => encodeURIComponent(value)

export const create__Pascal__ = (options: ClientOptions) => {
  const { request } = createRequest(options)
  return {
    getHealth: () => request<Answer<'getHealth'>>('/api/health'),
    // kit:methods
  }
}

export type __Pascal__ = ReturnType<typeof create__Pascal__>
