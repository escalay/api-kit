/** The feature switches as MCP tools. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'

type Feature = { key: string; title: string; on: boolean; own: boolean; source: string; blockedBy: string[]; locked: boolean; overrides: { scope: string; on: boolean }[] }
const stateWords = (feature: Feature) =>
  feature.on ? 'on' : feature.locked ? 'off (locked by FEATURES_OFF)' : feature.blockedBy.length ? `off (needs ${feature.blockedBy.join(', ')})` : `off (${feature.source})`
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
      'Switches a feature on or off for everyone, one person (person:<email>) or one API key (key:<name>); state default removes that switch, so the next less specific one decides. Owner only. Features that need it stop too: try with preview first, which changes nothing and lists what would change.',
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
