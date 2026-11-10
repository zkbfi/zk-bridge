import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Copies text: the clipboard first; if the browser refuses, the text of the element is selected and the old copy command tried. */
export const copyText = async (text: string, fallbackNode: Node | null): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: fall through to the selection.
  }
  if (fallbackNode === null) return false;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(fallbackNode);
  selection?.removeAllRanges();
  selection?.addRange(range);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
};

/** The state of one copy control: whether "Copied" shows (for two seconds), and the click handler. */
export const useCopy = (value: string, fallbackNode: () => Node | null) => {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    void copyText(value, fallbackNode()).then((copied) => {
      setMessage(copied ? "Copied" : "Selected: press Ctrl+C or Cmd+C to copy");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(""), 2000);
    });
  };
  return { message, copy };
};

/**
 * A hash or address that copies its full value when clicked, or on Enter or Space. What shows may be a short form
 * (`children`); the whole value is what is copied and what the title tells.
 */
export const CopyValue = ({ value, label, children, className = "" }: { readonly value: string; readonly label: string; readonly children?: ReactNode; readonly className?: string }) => {
  const shown = useRef<HTMLButtonElement>(null);
  const { message, copy } = useCopy(value, () => shown.current);
  return (
    <>
      <button type="button" ref={shown} className={`zb-copyable zb-mono ${className}`.trim()} title={label} aria-label={label} onClick={copy}>
        {children ?? value}
      </button>
      <span className="zb-copystatus" role="status" aria-live="polite">{message}</span>
    </>
  );
};
