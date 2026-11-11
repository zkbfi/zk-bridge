/** Click-to-copy for hashes and addresses: one markup helper and one behaviour, used for every such value on the page. */

/** What the page needs from the browser to copy. Tests pass fakes. */
export type CopyEnv = {
  /** The asynchronous clipboard, when the browser has one. */
  writeText: ((text: string) => Promise<void>) | null;
  /** Selects the text of the element and tries the old copy command. Returns whether the command copied it. */
  selectAndCopy: (element: CopyTarget) => boolean;
  later: (action: () => void, milliseconds: number) => void;
};

/** The parts of an element the copy behaviour touches. */
export type CopyTarget = {
  dataset: Record<string, string | undefined>;
  nextElementSibling: { textContent: string | null } | null;
};

export const COPIED_TEXT = "Copied";
export const SELECTED_TEXT = "Selected: press Ctrl+C or Cmd+C to copy";
const CONFIRMATION_MILLISECONDS = 2000;

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Markup for a value that copies when clicked, or when Enter or Space is pressed on it. The full value stays visible
 * and selectable. The status element right after it announces the result.
 */
export function copyable(value: string, label: string): string {
  const text = escapeAttribute(value);
  const name = escapeAttribute(label);
  return `<span class="copy-wrap"><code class="copyable" role="button" tabindex="0" data-copy="${text}" title="${name}" aria-label="${name}">${text}</code><span class="copy-status" role="status" aria-live="polite"></span></span>`;
}

/** Copies the value of the element and shows the result in its status element. */
export async function copyValue(element: CopyTarget, env: CopyEnv): Promise<boolean> {
  const status = element.nextElementSibling;
  const show = (message: string): void => {
    if (status === null) return;
    status.textContent = message;
    env.later(() => {
      if (status.textContent === message) status.textContent = "";
    }, CONFIRMATION_MILLISECONDS);
  };
  const value = element.dataset.copy ?? "";
  try {
    if (env.writeText !== null) {
      await env.writeText(value);
      show(COPIED_TEXT);
      return true;
    }
  } catch {
    // The browser refused the clipboard: fall back to the selection.
  }
  if (env.selectAndCopy(element)) {
    show(COPIED_TEXT);
    return true;
  }
  show(SELECTED_TEXT);
  return false;
}

/** The real browser: the clipboard, a text selection and `execCommand`, and timers. */
export function browserCopyEnv(): CopyEnv {
  return {
    writeText: navigator.clipboard?.writeText !== undefined ? (text) => navigator.clipboard.writeText(text) : null,
    selectAndCopy: (element) => {
      const node = element as unknown as Node;
      const selection = globalThis.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    },
    later: (action, milliseconds) => void setTimeout(action, milliseconds),
  };
}

type Closest = { closest?: (selector: string) => CopyTarget | null };

function copyableOf(target: unknown): CopyTarget | null {
  const closest = (target as Closest | null)?.closest;
  return typeof closest === "function" ? (target as { closest: (selector: string) => CopyTarget | null }).closest(".copyable") : null;
}

/** Makes every `.copyable` inside the root work, now and after the root is drawn again. */
export function wireCopy(
  root: { addEventListener: (type: string, listener: (event: any) => void) => void },
  env: CopyEnv = browserCopyEnv(),
): void {
  root.addEventListener("click", (event: { target: unknown }) => {
    const element = copyableOf(event.target);
    if (element !== null) void copyValue(element, env);
  });
  root.addEventListener("keydown", (event: { target: unknown; key: string; preventDefault: () => void }) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = copyableOf(event.target);
    if (element === null) return;
    event.preventDefault();
    void copyValue(element, env);
  });
}
