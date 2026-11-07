/** The operator pages named in public-pages.json, as `docs/<path>` to file text (see public-pages.ts). */
declare module "virtual:public-operator-pages" {
  const pages: Readonly<Record<string, string>>;
  export default pages;
}

/** The chains and contracts that pages embed with placeholders (see machine/plugin.ts). */
declare module "virtual:docs-facts" {
  import type { Facts } from "../machine/facts.ts";
  const facts: Facts;
  export default facts;
}
