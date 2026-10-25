/**
 * Loading and saving the prover setup file. The file holds references to secrets and never a secret value.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { emptyProverSetup, parseProverSetup, type ProverSetup } from './prover-setup'

/** The directory of the dashboard configuration: `EXPLORER_CONFIG_DIR`, else the XDG directory, else `~/.config`. */
export function configDirectory(environment: Readonly<Record<string, string | undefined>>): string {
  if (environment.EXPLORER_CONFIG_DIR) return environment.EXPLORER_CONFIG_DIR
  const base = environment.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'zk-bridge-explorer')
}

/** The path of the setup file. */
export function setupFilePath(environment: Readonly<Record<string, string | undefined>>): string {
  return join(configDirectory(environment), 'prover-setup.json')
}

/** The path of the encrypted secret file, used when the operating system has no secret store. */
export function encryptedSecretsPath(environment: Readonly<Record<string, string | undefined>>): string {
  return join(configDirectory(environment), 'secrets.enc.json')
}

/** Reads the setup. A missing file gives the empty setup. */
export async function loadProverSetup(path: string): Promise<ProverSetup> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyProverSetup()
    throw error
  }
  return parseProverSetup(JSON.parse(text))
}

/** Writes the setup with mode 0600 through a temporary file and a rename. It validates before it writes. */
export async function saveProverSetup(path: string, setup: ProverSetup): Promise<void> {
  parseProverSetup(JSON.parse(JSON.stringify(setup)))
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
