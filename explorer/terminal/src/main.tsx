/**
 * Entry point: `bun run src/main.tsx`. It starts the renderer with the services that `app/bootstrap.ts` builds.
 * The environment variables are described there.
 */
import { readFile } from 'node:fs/promises'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { App } from './app/App'
import { buildServices } from './app/bootstrap'

try {
  const { services, initialSigner } = await buildServices({
    environment: process.env,
    workingDirectory: process.cwd(),
    readTextFile: (path) => readFile(path, 'utf8'),
    now: () => Math.floor(Date.now() / 1000),
  })
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App services={{ ...services, quit: () => renderer.destroy() }} initialSigner={initialSigner} />)
} catch (error) {
  // The renderer is not running here, so a plain message on standard error is safe. The exit code tells scripts.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
