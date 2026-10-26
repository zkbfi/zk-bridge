/**
 * A fake of the `ponder:registry` module. `ponder.on` stores each handler so that a test can call it with an event and
 * a context, the way the Ponder runtime does.
 */

/** A handler as `ponder.on` receives it. The event and the context are plain objects in a test. */
export type RegisteredHandler = (input: { event: never; context: never }) => Promise<unknown> | unknown;

/** The handlers by event name. */
export const handlers = new Map<string, RegisteredHandler>();

/** The fake registry. */
export const ponder = {
  on: (name: string, handler: RegisteredHandler): void => {
    if (handlers.has(name)) throw new Error(`two handlers for ${name}`);
    handlers.set(name, handler);
  },
};

/**
 * Calls the handler of an event.
 *
 * @param name The event name, such as `MessageBridge:DepositsOpened`.
 * @param input The event and the context.
 */
export const callHandler = async (name: string, input: { readonly event: unknown; readonly context: unknown }): Promise<unknown> => {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`no handler for ${name}`);
  return handler(input as { event: never; context: never });
};
