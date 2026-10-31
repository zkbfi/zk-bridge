import type { ReactNode } from "react";
import { Sheet } from "./Sheet.js";

/** Props of {@link ReviewSheet}. */
export type ReviewSheetProps = {
  /** The accessible name and heading; default `Review`. */
  readonly label?: string;
  readonly onClose: () => void;
  /** The rows ({@link ReviewRow}), the notices ({@link ReviewNotice}) and the host's own buttons. */
  readonly children: ReactNode;
};

/**
 * The review sheet: the sheet that shows what is about to be signed, as rows and notices. What the rows say and what the
 * buttons do are the host's; the sheet owns the frame (focus, Escape, scrim, the close button, the column).
 *
 * @param props The label, the close handler and the content.
 */
export const ReviewSheet = ({ label = "Review", onClose, children }: ReviewSheetProps) => (
  <Sheet label={label} onClose={onClose}>
    <div className="zb-sheet-col zb-review">{children}</div>
  </Sheet>
);

/** Props of {@link ReviewRow}. */
export type ReviewRowProps = {
  readonly label: string;
  /** A smaller, indented row under the one above (a part of the fee). */
  readonly sub?: boolean;
  readonly children: ReactNode;
};

/**
 * One row of the review: a label and its value.
 *
 * @param props The label, whether it is a sub row and the value.
 */
export const ReviewRow = ({ label, sub = false, children }: ReviewRowProps) => (
  <div className={sub ? "zb-kv zb-kv-sub" : "zb-kv"}>
    <span className="zb-k">{label}</span>
    {children}
  </div>
);

/** Props of {@link ReviewNotice}. */
export type ReviewNoticeProps = {
  /** `alert` announces the notice at once; `group` (with `groupLabel`) holds a notice that has buttons in it; none is plain. */
  readonly role?: "alert" | "group";
  readonly groupLabel?: string;
  readonly children: ReactNode;
};

/**
 * A boxed notice in the review: a warning the user reads before confirming.
 *
 * @param props The role and the content.
 */
export const ReviewNotice = ({ role, groupLabel, children }: ReviewNoticeProps) => (
  <div className="zb-warnbox" {...(role === undefined ? {} : { role })} {...(groupLabel === undefined ? {} : { "aria-label": groupLabel })}>
    {children}
  </div>
);
