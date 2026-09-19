import "solid-js"

interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_HOST: string
  readonly VITE_OPENCODE_SERVER_PORT: string
  readonly VITE_AETHER_AUTH_URL?: string
  readonly VITE_AETHER_CHANNEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
