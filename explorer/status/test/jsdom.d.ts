/** The part of jsdom that the page test uses (the package ships no types; the web package gets its DOM from vitest). */
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string, options?: { url?: string; runScripts?: "dangerously"; pretendToBeVisual?: boolean; beforeParse?: (window: Window & typeof globalThis) => void });
    readonly window: Window & typeof globalThis;
  }
}
