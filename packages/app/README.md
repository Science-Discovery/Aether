## Usage

Dependencies for these templates are managed with [pnpm](https://pnpm.io) using `pnpm up -Lri`.

This is the reason you see a `pnpm-lock.yaml`. That said, any package manager will work. This file can safely be removed once you clone a template.

```bash
$ npm install # or pnpm install or yarn install
```

### Learn more on the [Solid Website](https://solidjs.com) and come chat with us on our [Discord](https://discord.com/invite/solidjs)

## Available Scripts

In the project directory, you can run:

### `npm run dev` or `npm start`

Runs the app in the development mode.<br>
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

The page will reload if you make edits.<br>

### `npm run build`

Builds the app for production to the `dist` folder.<br>
It correctly bundles Solid in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.<br>
Your app is ready to be deployed!

## E2E Testing

Playwright starts the Vite dev server via `webServer` on a free OS-assigned port, and unless an external backend is requested it also starts a throwaway Aether backend (temp sandbox home, seeded models) on another free port. Multiple e2e runs can therefore execute in parallel on the same machine without port conflicts.
Use the local runner to create a temp sandbox, seed data, and run the tests:

```bash
bunx playwright install
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (target an external backend instead of starting one; they must be set together — `HOST` without `PORT` is rejected instead of silently pinning a shared backend port; without them both ports are auto-assigned)
- `PLAYWRIGHT_PORT` (Vite dev server port, default: a free OS-assigned port; setting it explicitly opts into reusing an already-running dev server outside CI — auto-assigned ports never reuse)
- `PLAYWRIGHT_BASE_URL` (override base URL, default: `http://127.0.0.1:<PLAYWRIGHT_PORT>`)

Auto-assigned ports fail loudly on collisions (no silent reuse of another run's server), and the throwaway backend only answers a health probe carrying this run's id.

## Deployment

You can deploy the `dist` folder to any static host provider (netlify, surge, now, etc.)
