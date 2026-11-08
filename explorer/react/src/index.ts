/**
 * @zkb/react: the React layer of the zkb.fi bridge screen, on top of `@zkb/core` (the rules) and `@zkb/data` (the
 * fetching). Hooks for the fee, the verdict, prices at a block and delivery status, and the self-contained components
 * (sheet, review sheet, token and chain icons). The host passes in every read; import `@zkb/react/styles.css` for the
 * look, and theme it with the `--zkb-*` CSS variables. See README.md.
 */

// Fee: the default fee, the warnings, the hard cap and the two stored caps
export {
  plainNumber,
  capWadOf,
  useDefaultFee,
  type DefaultFeeInput,
  useFeeWarnings,
  type FeeWarningsResult,
  useHardCap,
  type HardCapInput,
  type HardCapResult,
  useFeeCaps,
  type CapStorage,
  type FeeCaps,
} from "./fee.js";
export {
  DEFAULT_AUTO_CAP_PERCENT,
  DEFAULT_HARD_CAP_PERCENT,
  feeCapProblem,
  loadFeeCap,
  loadHardCap,
  saveFeeCap,
  saveHardCap,
} from "./fee-cap.js";

// Verdict: what the Bridge pill says
export { verdictOf, pressable, useVerdict, type Verdict, type VerdictInput } from "./verdict.js";

// Prices at a block
export {
  PRICE_NOTE,
  PRICE_REFRESH_MILLISECONDS,
  STALE_PRICE_MAX_SECONDS,
  priceProblemOf,
  tokenPriceKey,
  nativePriceKey,
  samplePrices,
  loadPrices,
  usePrices,
  type PriceableToken,
  type PriceablePair,
  type PriceMap,
  type PriceSource,
  type UsePricesOptions,
  type PricesState,
  type PriceState,
  type PriceStates,
  type PriceProblem,
  type CountingPoolReader,
} from "./prices.js";

// Delivery status
export {
  NEEDS_YOU_AFTER_SECONDS,
  stepOf,
  positionOf,
  stepWords,
  groupOf,
  useDeliveryStatus,
  type ActivityGroup,
  type DeliveryStatusInput,
  type DeliveryStatusView,
} from "./delivery-status.js";

// Components
export { Sheet, CloseButton, type SheetProps } from "./Sheet.js";
export { ReviewSheet, ReviewRow, ReviewNotice, type ReviewSheetProps, type ReviewRowProps, type ReviewNoticeProps } from "./Review.js";
export { TokenIcon, type TokenIconProps } from "./TokenIcon.js";
export { DEFAULT_IMAGE_SERVER, iconUrl, type IconSubject, type IconSources, type ShippedIcons } from "./icon-source.js";
