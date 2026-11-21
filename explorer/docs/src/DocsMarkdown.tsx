/**
 * The body of a page in the app's type scale and tokens: headings, paragraphs, lists, tables, code, and block quotes
 * drawn as callouts (a note on the raised surface, a warning in the app's warning style). The title is not drawn here:
 * it sits on the band. Nothing is injected as markup; the Markdown reader builds data and this turns it into elements.
 */
import type { ReactNode } from "react";
import { Num } from "@web/bridge/Num";
import { FaucetBlock } from "./FaucetBlock";
import type { Block, Inline } from "@web/docs/markdown";

/** A shown number with three or more zeros after the point, anywhere in a text (the app's leading-zeros rule). */
const SMALL_NUMBER = /\b0\.0{3,}\d+\b/g;

/**
 * A text with every small number collapsed as the app shows it (0.0001234 as 0.0₃1234).
 *
 * @param text The text of a table cell.
 * @param key The key prefix.
 */
export const withNumbers = (text: string, key: string): ReactNode => {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(SMALL_NUMBER)) {
    const at = match.index;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(<Num key={`${key}-n${at}`} text={match[0]} />);
    last = at + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
};

const renderInline = (items: readonly Inline[], key: string, numbers = false): ReactNode =>
  items.map((item, index) => {
    const itemKey = `${key}-${index}`;
    if (item.kind === "text") return numbers ? <span key={itemKey}>{withNumbers(item.text, itemKey)}</span> : item.text;
    if (item.kind === "code") return <code key={itemKey} className="zd-code">{item.text}</code>;
    if (item.kind === "bold") return <strong key={itemKey}>{renderInline(item.children, itemKey, numbers)}</strong>;
    if (item.kind === "italic") return <em key={itemKey}>{renderInline(item.children, itemKey, numbers)}</em>;
    // An https address leaves the site, so it opens in a new tab without handing over the page or its address. A route stays a hash link.
    const leaves = item.href.startsWith("https:");
    return (
      <a key={itemKey} className="zd-a" href={item.href} {...(leaves ? { rel: "noopener noreferrer", target: "_blank" } : {})}>
        {renderInline(item.children, itemKey, numbers)}
      </a>
    );
  });

const plainText = (items: readonly Inline[]): string =>
  items.map((item) => (item.kind === "text" || item.kind === "code" ? item.text : plainText(item.children))).join("");

const WARNING = /^(warning|caution|danger|important|do not|never)\b/i;

/**
 * Whether a block quote is a warning: its text opens with Warning, Caution, Danger, Important, Do not or Never.
 *
 * @param items The text of the quote.
 */
export const isWarning = (items: readonly Inline[]): boolean => WARNING.test(plainText(items).trim());

const NUMERIC = /^[\s$€£%+\-−~≈<>.,0-9₀-₉]+$/;

const cellClass = (items: readonly Inline[]): string | undefined => (NUMERIC.test(plainText(items)) && /\d/.test(plainText(items)) ? "zd-num" : undefined);

const renderBlock = (block: Block, index: number): ReactNode => {
  const key = `b${index}`;
  if (block.kind === "heading") {
    if (block.level === 1) return null;
    const Tag = `h${block.level}` as "h2" | "h3" | "h4";
    return (
      <Tag key={key} id={block.id} className={`zd-h zd-h${block.level}`}>
        {block.text}
      </Tag>
    );
  }
  if (block.kind === "paragraph") return <p key={key} className="zd-p">{renderInline(block.children, key)}</p>;
  if (block.kind === "quote") {
    const warning = isWarning(block.children);
    return (
      <div key={key} role="note" className={warning ? "zd-callout zd-warn" : "zd-callout"}>
        {renderInline(block.children, key)}
      </div>
    );
  }
  if (block.kind === "faucet") return <FaucetBlock key={key} chainId={block.chainId} />;
  if (block.kind === "code") {
    return (
      <pre key={key} className="zd-pre" tabIndex={0}>
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List key={key} className="zd-list">
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
        ))}
      </List>
    );
  }
  return (
    <div key={key} className="zd-table" role="region" aria-label="Table" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {block.header.map((cell, cellIndex) => (
              <th key={`${key}-h${cellIndex}`} scope="col" className={cellClass(block.rows[0]?.[cellIndex] ?? [])}>
                {renderInline(cell, `${key}-h${cellIndex}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${key}-r${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${key}-r${rowIndex}-${cellIndex}`} className={cellClass(cell)}>
                  {renderInline(cell, `${key}-r${rowIndex}-${cellIndex}`, true)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * The body of a page, with its title left out (the band shows it).
 *
 * @param props The blocks.
 */
export const DocsMarkdown = ({ blocks }: { readonly blocks: readonly Block[] }) => <div className="zd-body">{blocks.map(renderBlock)}</div>;
