import { useEffect, useRef, type ReactNode } from "react";

/** Props of {@link Sheet}. */
export type SheetProps = {
  /** The accessible name. Shown as a heading only when `showTitle` is set (the token picker has no title). */
  readonly label: string;
  readonly showTitle?: boolean;
  /** No accent edge on top (the token picker opens on its own orange search band). */
  readonly bare?: boolean;
  /** On desktop, hang from near the top instead of rising from the bottom, so a list that changes length never moves the field (search). */
  readonly top?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
};

/** An icon-only round close button (owner: "make the remove button just an icon+button"). */
export const CloseButton = ({ onClose, label = "Close" }: { readonly onClose: () => void; readonly label?: string }) => (
  <button type="button" className="zb-close" aria-label={label} onClick={onClose}>
    <svg viewBox="0 0 12 12" className="zb-icon" aria-hidden="true" focusable="false">
      <path d="M3 3l6 6M9 3 3 9" />
    </svg>
  </button>
);

/**
 * A square panel that rises from the bottom edge, full width, on phones and sits as a centred modal on desktop, over
 * the dimmed page. Escape and the scrim close it; focus moves in and returns.
 *
 * @param props The label, the close handler and the content.
 */
export const Sheet = ({ label, showTitle = true, bare = false, top = false, onClose, children }: SheetProps) => {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, button, [tabindex]")?.focus();
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="zb-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panel} className={["zb-sheet", bare ? "zb-sheet-bare" : "", top ? "zb-sheet-top" : ""].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-label={label}>
        {showTitle ? (
          <div className="zb-col zb-sheet-head">
            <h2>{label}</h2>
            <span style={{ marginLeft: "auto" }}>
              <CloseButton onClose={onClose} />
            </span>
          </div>
        ) : null}
        {children}
      </div>
    </>
  );
};
