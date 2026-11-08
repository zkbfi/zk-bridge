/** Where the public notes and signed files of a release live (the same place the landing downloads from). */
const RELEASE_PAGE = "https://github.com/zkbfi/releases/releases/tag/v";

/** What the footer shows for the build: the label and, for a real release, the page of that release. */
export type ReleaseInfo = { readonly label: string; readonly href: string | null };

/**
 * The release this build is. `VITE_ZKB_VERSION` is set by script/release/release.sh to the release version (for
 * example 0.1.2-next.16). Without it, or on a page of sample data, the label is "dev" and there is no link.
 *
 * @param version The value of `VITE_ZKB_VERSION`, or undefined.
 * @param sample Whether the page runs on sample data.
 */
export const releaseInfo = (version: string | undefined, sample: boolean): ReleaseInfo => {
  const text = version?.trim() ?? "";
  if (sample || text === "") return { label: "dev", href: null };
  return { label: text, href: `${RELEASE_PAGE}${encodeURIComponent(text)}` };
};
