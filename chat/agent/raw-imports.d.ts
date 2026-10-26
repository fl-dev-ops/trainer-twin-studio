// eve embeds `?raw` asset imports as UTF-8 text.
declare module "*?raw" {
  const content: string;
  export default content;
}
