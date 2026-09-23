const config = (await import("../playwright.config")).default as {
  webServer: unknown
  use?: { baseURL?: string }
}

const servers = [config.webServer].flat() as Array<{ command: string; url: string; env?: Record<string, string> }>

console.log(
  JSON.stringify({
    servers: servers.map((server) => ({ command: server.command, url: server.url, env: server.env })),
    baseURL: config.use?.baseURL,
    serverPort: process.env.PLAYWRIGHT_SERVER_PORT,
  }),
)

export {}
