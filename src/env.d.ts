// Allows importing .html files as text (wired up via the Text rule in wrangler.jsonc)
declare module "*.html" {
  const content: string;
  export default content;
}
