/** The icons the footer can draw (see Footer.tsx). */
export type SocialIcon = "github" | "x" | "discord" | "telegram";

/** One link in the footer: the name is the accessible name, the url is where it goes, the icon is drawn in the text colour. */
export type SocialLink = { readonly name: string; readonly url: string; readonly icon: SocialIcon };

/**
 * The social links at the right of the footer, in order. This is the one place to edit them: another account is one
 * more item. An entry with an empty url is not shown. GitHub is the public releases repository (zkbfi/releases).
 */
export const SOCIAL_LINKS: readonly SocialLink[] = [
  { name: "Telegram", url: "https://t.me/zkbfi", icon: "telegram" },
  { name: "GitHub", url: "https://github.com/zkbfi/releases", icon: "github" },
];
