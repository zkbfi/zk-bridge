/**
 * The fork schedule copies of a program that runs on a disk (the terminal, the status service): one file per chain in a
 * directory, written through a temporary file and a rename. The store of `@zkb/data` (`createForkScheduleStore`) wraps it
 * and swallows its errors, so a read-only disk only means that no copy is kept.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ForkScheduleText } from '@zkb/data'
import { configDirectory } from './setup-file.js'

/** The directory of the copies in the dashboard configuration directory. */
export function forkScheduleDirectory(environment: Readonly<Record<string, string | undefined>>): string {
  return join(configDirectory(environment), 'fork-schedules')
}

/**
 * Text in files of one directory, one file per key (`<key>.json`). A missing file reads as null; the directory is made
 * on the first write.
 *
 * @param directory The directory.
 */
export function fileForkScheduleText(directory: string): ForkScheduleText {
  const pathOf = (key: string) => join(directory, `${key}.json`)
  return {
    read: async (key) => {
      try {
        return await readFile(pathOf(key), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    write: async (key, text) => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${pathOf(key)}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, pathOf(key))
    },
  }
}
