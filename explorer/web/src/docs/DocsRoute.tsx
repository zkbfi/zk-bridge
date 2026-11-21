/**
 * The docs inside the dapp, loaded on demand. Owner, verbatim: "perhaps docs should be async loaded in the same app as
 * dapp? no need to consume a second domain" and "yes, point docs.zkb.fi at the dapp. have it go to /#/docs".
 *
 * The docs site (`explorer/docs`) is a dynamic import: its code, its styles and its Markdown pages are a separate chunk
 * that the browser downloads only when the address is a docs route, so the bridge screen's first bundle does not grow.
 */
import { Component, lazy, Suspense, type ReactNode } from "react";

const DocsPage = lazy(() => import("@docs/DocsPage"));

/** Props of {@link DocsRoute}. */
export type DocsRouteProps = {
  /** The page named by the address, or null for the front page of the docs. */
  readonly slug: string | null;
  /** The heading named by the address, or null. */
  readonly heading: string | null;
  /** The chain ids of the pair the app runs on, for the pages that are about particular chains. */
  readonly chainIds?: readonly number[];
};

type BoundaryState = { readonly failed: boolean };

/** Shows a sentence when the docs chunk cannot be downloaded (offline, or a gateway that dropped the file). */
class DocsBoundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <main className="zb" role="alert" style={{ padding: "2rem 1rem", maxWidth: "40rem", margin: "0 auto" }}>
        <p>The docs could not be loaded. Check your connection and reload the page. The bridge itself works without them: <a href="#/">open the bridge</a>.</p>
      </main>
    ) : (
      this.props.children
    );
  }
}

/**
 * The docs route: a short loading line while the chunk downloads, then the docs site.
 *
 * @param props The page and the heading from the address, and the chains of the pair.
 */
export const DocsRoute = ({ slug, heading, chainIds }: DocsRouteProps) => (
  <DocsBoundary>
    <Suspense
      fallback={
        <main className="zb" role="status" style={{ padding: "2rem 1rem", maxWidth: "40rem", margin: "0 auto" }}>
          Loading the docs…
        </main>
      }
    >
      <DocsPage slug={slug} heading={heading} {...(chainIds === undefined ? {} : { chainIds })} />
    </Suspense>
  </DocsBoundary>
);
