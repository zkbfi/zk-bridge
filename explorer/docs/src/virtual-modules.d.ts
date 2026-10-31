/** The operator pages named in public-pages.json, as `docs/<path>` to file text (see public-pages.ts). */
declare module "virtual:public-operator-pages" {
  const pages: Readonly<Record<string, string>>;
  export default pages;
}
