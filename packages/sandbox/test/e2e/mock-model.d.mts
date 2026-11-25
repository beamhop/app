// Types for the test-only servers (plain .mjs so the e2e runner needs no build step).
import type { Server } from 'node:http'

export const FILE_NAME: string
export const FILE_TEXT: string
export const SHELL_CMD: string
export const FINAL_PREFIX: string
export interface MockLogEntry {
  method: string
  path: string
  kind?: string
  step?: number
  agentRequest?: boolean
  via: string | null
  lastToolResult?: string
  headers: Record<string, string | string[] | undefined>
}
export function startMock(opts?: { port?: number; delayMs?: number }): Promise<{ server: Server; port: number; log: MockLogEntry[]; close(): Promise<void> }>
