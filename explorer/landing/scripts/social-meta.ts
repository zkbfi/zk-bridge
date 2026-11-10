/** The og:image and twitter:image tags for a page, with the image at an absolute address (1200x630). */
export function socialMeta(title: string, imageUrl: string): string {
  const escape = (value: string): string => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  const image = escape(imageUrl);
  return [
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ].join("\n    ");
}
