/** The feature switches as MCP tools. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'

type Feature = { key: string; title: string; on: boolean; own: boolean; source: string; scope?: string; changedBy?: string; changedAt?: string; blockedBy: string[]; locked: boolean; overrides: { scope: string; on: boolean }[] }
/** Who a feature is on or off for and who decided, in words: the store's name never stands alone. */
const stateWords = (feature: Feature) => {
  const state = feature.own ? 'on' : 'off'
  if (feature.locked) return 'off, locked by FEATURES_OFF in the deployment’s settings'
  if (feature.own && feature.blockedBy.length) return `off, because it needs ${feature.blockedBy.join(', ')}`
  if (feature.source === 'default') return `${state} by default`
  const whom = !feature.scope || feature.scope === 'everyone' ? 'for everyone' : `for ${feature.scope}`
  return `${state} ${whom}${feature.changedBy ? `, switched by ${feature.changedBy}${feature.changedAt ? ` ${feature.changedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}` : ` (from ${feature.source})`}`
}
const line = (feature: Feature) => {
  const others = feature.overrides.filter((override) => override.scope !== 'everyone')
  return `${feature.key} · ${stateWords(feature)} · ${feature.title}${others.length ? ` · ${others.map((override) => `${override.scope} ${override.on ? 'on' : 'off'}`).join(', ')}` : ''}`
}

/**
 * The MCP tools for feature switches: list them, and switch one (owner only, on the route).
 *
 * @example
 * mcpServerFactory({ tools: [...featureTools, ...switchTools()], … })
 */
export const switchTools = ({ path = '/api/features', example = 'webhooks' }: { path?: string; example?: string } = {}): McpTool[] => [
  mcpTool({
    name: 'list_features',
    title: 'Features',
    description: 'Every feature that can be switched off, whether it works for you and why (its own switch, a feature it needs, or FEATURES_OFF). A feature that is off answers its tools with 403 feature_disabled.',
    input: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    cli: { name: 'feature list', examples: [{ run: 'feature list', about: 'Which features are on' }] },
    call: () => ({ path }),
    summarize: (json: { _embedded: { features: Feature[] }; unknownOff: string[] }) =>
      [...json._embedded.features.map(line), ...(json.unknownOff.length ? [`FEATURES_OFF names no feature: ${json.unknownOff.join(', ')}.`] : [])].join('\n'),
  }),
  mcpTool({
    name: 'switch_feature',
    title: 'Switch a feature',
    description:
      'Switches a feature on or off for everyone, one person (person:<email>) or one API key (key:<name>); state default removes that switch, so the next less specific one decides. Owner only, and only on the user’s word: a feature found off is reported to the user, never switched on to finish a task. Features that need it stop too: try with preview first, which changes nothing and lists what would change.',
    input: z.object({
      key: z.string().describe('The feature’s key, from list_features.'),
      state: z.enum(['on', 'off', 'default']).describe('on, off, or default to remove this scope’s switch.'),
      scope: z.string().optional().describe('everyone (the default), person:<email> or key:<name>.'),
      preview: z.boolean().optional().describe('true: change nothing, say what would change.'),
    }),
    annotations: { openWorldHint: false },
    cli: { name: 'feature switch', examples: [{ run: `feature switch ${example} --state off --preview`, about: 'What switching it off would stop' }] },
    call: ({ key, state, scope, preview }) => ({
      method: 'PATCH',
      path: `${path}/${key}`,
      ...(preview ? { query: { dryRun: 'true' } } : {}),
      body: { on: state === 'default' ? null : state === 'on', ...(scope ? { scope } : {}) },
    }),
    summarize: (json: { dryRun: boolean; key: string; scope: string; changes: { key: string; on: boolean }[]; feature: Feature }) =>
      [
        `${json.dryRun ? 'Would change' : 'Changed'} for ${json.scope}: ${json.changes.length ? json.changes.map((change) => `${change.key} ${change.on ? 'on' : 'off'}`).join(', ') : 'nothing'}.`,
        `Now: ${line(json.feature)}`,
      ].join('\n'),
  }),
]

/**
 * featureTools tells, in each tool's description, which switchable feature it belongs to, so an agent that gets 403
 * `feature_disabled` from it knows which switch is meant.
 *
 * @example
 * tools: FEATURES.flatMap((feature) => (feature.switch ? featureTools(feature.tools, CATALOG, feature.switch) : feature.tools))
 */
export const featureTools = (tools: McpTool[], catalog: Readonly<Record<string, { title: string }>>, key: string): McpTool[] =>
  tools.map((tool) => ({ ...tool, description: `${tool.description} Part of the feature ${catalog[key]?.title ?? key} (\`${key}\`), which an owner can switch off: then it answers 403 feature_disabled.` }))
