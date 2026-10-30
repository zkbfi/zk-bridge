import { collapseZeros } from "./number";

/**
 * A shown number. Three or more leading zeros collapse into a subscript count (0.0₃1234); screen readers get the
 * full value.
 *
 * @param props The decimal text.
 */
export const Num = ({ text }: { readonly text: string }) => {
  const parts = collapseZeros(text);
  if (parts === null) return <>{text}</>;
  return (
    <span className="zb-zeros" aria-label={text}>
      <span aria-hidden="true">
        {parts.lead}
        <sub>{parts.zeros}</sub>
        {parts.rest}
      </span>
    </span>
  );
};
