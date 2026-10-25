/**
 * Test preload. Polling hooks update state from timers, outside `act`. React then prints a warning for every update.
 * The warning does not mean a bug here, and it buries real output, so this file drops that one message.
 */
const originalError = console.error
console.error = (...parts: unknown[]) => {
  if (typeof parts[0] === 'string' && parts[0].includes('not wrapped in act')) return
  originalError(...parts)
}
