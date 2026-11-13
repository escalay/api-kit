/** The probe's usage report, apart from worker.ts: a Worker's main module exports only its handlers. */
import { countRange, telemetry } from '../../src/index.js'

/** The collector is never called from here: its fetch answers locally. */
export const probeTelemetry = (send: typeof fetch = async () => Response.json({ latest: '1.0.1' })) =>
  telemetry({ product: 'probe', schemaVersion: 1, version: '1.0.0', url: 'https://collector.invalid', collect: () => ({ notes: countRange(2), signed_in: false }), fetch: send })
