/**
 * Ambient browser-side globals for the dsh client bundle half (client.ts).
 * The dsh web client materializes plugins through window.__ModuleLoader__ and
 * passes a synchronous require ('react') into each factory.
 */
declare global {
  interface Window {
    __ModuleLoader__: {
      load(definition: { id: string; factory: (require: (id: string) => any) => any }): void
    }
  }
}

export {}
