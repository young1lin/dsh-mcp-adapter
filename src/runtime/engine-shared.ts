/** Host-owned dependencies shared with the agent-plane plugin. */
import type { EngineSupervisor } from './engine-supervisor.js'
import type { ConfigService } from '../config/service.js'

export interface SharedRuntime {
  engine: EngineSupervisor
  config: ConfigService
  storageDir: string
  workspaceIdFor(cwd: string, sessionId: string): string | undefined
}
let current: EngineSupervisor | undefined
let runtime: SharedRuntime | undefined
export function publishEngine(supervisor: EngineSupervisor | undefined): void {
  current = supervisor
  if (runtime?.engine !== supervisor) runtime = undefined
}
export function sharedEngine(): EngineSupervisor | undefined { return current }
export function publishRuntime(value: SharedRuntime | undefined): void {
  runtime = value
  current = value?.engine
}
export function sharedRuntime(): SharedRuntime | undefined { return runtime }
