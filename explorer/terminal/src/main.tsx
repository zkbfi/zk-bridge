/**
 * Entry point: `bun run src/main.tsx`. It starts the renderer with the services that `app/bootstrap.ts` builds.
 * The environment variables are described there. `--version` and `--help` answer first and exit, so they never
 * load the renderer or its native library.
 */
import packageJson from '../package.json'
import { HELP_TEXT, parseCliArguments, renderVersionLine } from './cli-arguments'

/** Set at build time by `script/build-terminal.sh` through `--define`. It is absent when the source runs directly. */
declare const BUILD_COMMIT: string | undefined

/** Starts the dashboard. The renderer modules load here, after the arguments are known. */
async function runDashboard(): Promise<void> {
  const [{ readFile }, { createCliRenderer }, { createRoot }, { App }, { buildServices }] = await Promise.all([
    import('node:fs/promises'),
    import('@opentui/core'),
    import('@opentui/react'),
    import('./app/App'),
    import('./app/bootstrap'),
  ])
  const { services, initialSigner } = await buildServices({
    environment: process.env,
    workingDirectory: process.cwd(),
    readTextFile: (path) => readFile(path, 'utf8'),
    now: () => Math.floor(Date.now() / 1000),
  })
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App services={{ ...services, quit: () => renderer.destroy() }} initialSigner={initialSigner} />)
}

const action = parseCliArguments(process.argv.slice(2))

if (action.kind === 'version') {
  console.log(renderVersionLine({ version: packageJson.version, commit: typeof BUILD_COMMIT === 'string' ? BUILD_COMMIT : 'source' }))
} else if (action.kind === 'help') {
  // Help for a mistake goes to standard error, so a script that reads standard output sees nothing.
  const write = action.exitCode === 0 ? console.log : console.error
  write(HELP_TEXT)
  process.exitCode = action.exitCode
} else {
  try {
    await runDashboard()
  } catch (error) {
    // The renderer is not running here, so a plain message on standard error is safe. The exit code tells scripts.
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
