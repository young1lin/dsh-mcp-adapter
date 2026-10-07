/** Read-only browser projection. Never contains frozen defs, secrets or instance ids. */
export interface SessionToolView { name: string; publicName: string; description?: string }
export interface SessionServerView { name: string; transport: 'http' | 'stdio' | 'other'; tools: SessionToolView[] }
export interface SessionSnapshotView {
  revision: string
  registeredAt: string
  /** Compatibility for older clients. New clients use explicit server groups. */
  tools: string[]
  servers?: SessionServerView[]
  /** Legacy records lack the definitions/schemas needed to restore this catalog. */
  restorable?: boolean
}
export interface SessionConfigurationChanges { added: number; removed: number; changed: number }
