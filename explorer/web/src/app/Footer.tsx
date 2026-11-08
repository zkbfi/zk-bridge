import type { ReactNode } from "react";
import type { ReleaseInfo } from "./release-version";
import type { SocialIcon, SocialLink } from "./social-links";

const ICONS: Readonly<Record<SocialIcon, ReactNode>> = {
  github: <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />,
  x: <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.19L2 3h6.33l4.37 5.78L17.75 3zm-1.08 16.16h1.7L7.4 4.74H5.58l11.09 14.42z" />,
  discord: <path d="M19.27 5.33A16.6 16.6 0 0 0 15.1 4l-.2.4a15.4 15.4 0 0 1 3.7 1.2 14 14 0 0 0-13.2 0 15.4 15.4 0 0 1 3.7-1.2L8.9 4a16.6 16.6 0 0 0-4.17 1.33C2.1 9.3 1.4 13.1 1.75 16.85a16.7 16.7 0 0 0 5.1 2.58l1.1-1.77a10.8 10.8 0 0 1-1.73-.83l.42-.33a11.9 11.9 0 0 0 10.7 0l.42.33c-.55.33-1.13.6-1.73.83l1.1 1.77a16.7 16.7 0 0 0 5.1-2.58c.42-4.35-.7-8.12-2.96-11.52zM8.68 14.55c-1 0-1.8-.92-1.8-2.04s.8-2.04 1.8-2.04 1.82.92 1.8 2.04c0 1.12-.8 2.04-1.8 2.04zm6.64 0c-1 0-1.8-.92-1.8-2.04s.8-2.04 1.8-2.04 1.82.92 1.8 2.04c0 1.12-.8 2.04-1.8 2.04z" />,
  telegram: <path d="M21.5 3.6 2.9 10.8c-.8.3-.8 1.2 0 1.5l4.7 1.5 1.8 5.6c.2.6.9.8 1.4.4l2.6-2.2 4.7 3.5c.5.4 1.3.1 1.4-.6l3.1-15.2c.2-.8-.5-1.4-1.1-1.2zM9.5 13.4l8.2-5-6.5 6.2-.3 3.2-1.4-4.4z" />,
};

/** Props of {@link Footer}. */
export type FooterProps = { readonly release: ReleaseInfo; readonly links: readonly SocialLink[] };

/**
 * The foot of every dapp page. It is the last thing in the page column: short pages leave it at the bottom of the
 * window, long pages push it below the content. The release version is on the left (a link to the release when there
 * is one), the social links on the right. Links with no url are left out.
 *
 * @param props The release and the social links.
 */
export const Footer = ({ release, links }: FooterProps) => {
  const shown = links.filter((link) => link.url !== "");
  return (
    <footer className="zb-footer">
      <div className="zb-col zb-footer-row">
        <span className="zb-footer-version">
          {release.href === null ? (
            <span title="Not a release build">{release.label}</span>
          ) : (
            <a href={release.href} target="_blank" rel="noopener noreferrer" title="Release notes and signed files">
              {release.label}
            </a>
          )}
        </span>
        {shown.length === 0 ? null : (
          <ul className="zb-footer-links" aria-label="Social links">
            {shown.map((link) => (
              <li key={link.name}>
                <a href={link.url} target="_blank" rel="noopener noreferrer" aria-label={link.name} title={link.name}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">
                    {ICONS[link.icon]}
                  </svg>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </footer>
  );
};
