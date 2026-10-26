/**
 * The proof side configuration, the secret store and the redactor. Node.js and Bun import them. They sit behind the
 * subpath `@zk-bridge/shared/config`, not behind the main entry, because they read files and spawn processes, which a
 * browser cannot do.
 */
export * from './prover-setup.js'
export * from '../redaction.js'
export * from './secret-store.js'
export * from './setup-file.js'
export * from './connection-store.js'
