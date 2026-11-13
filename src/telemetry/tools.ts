/** The telemetry route as an MCP tool. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'

/**
 * The MCP tool for reading the usage report: whether it is on, and exactly what it sends. Switching it stays with the
 * owner, on the route.
 *
 * @example
 * mcpServerFactory({ tools: [...FEATURE_TOOLS, ...telemetryTools()], … })
 */
export const telemetryTools = ({ path = '/api/telemetry' }: { path?: string } = {}): McpTool[] => [
  mcpTool({
    name: 'get_telemetry',
    title: 'Usage report',
    description: 'Whether this deployment sends its daily anonymous usage report, and exactly the body it would send: coarse ranges and yes/no answers, never ids or text.',
    input: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    call: () => ({ path }),
    summarize: (json: { on: boolean; why: string; endpoint: string; body: unknown; latest: string | null }) =>
      [`The usage report is ${json.on ? 'on' : 'off'}: ${json.why}`, `It sends to ${json.endpoint}:`, JSON.stringify(json.body, null, 2), ...(json.latest ? [`Newest version: ${json.latest}.`] : [])].join('\n'),
  }),
]
