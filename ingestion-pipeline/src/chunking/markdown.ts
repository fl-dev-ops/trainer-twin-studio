export const CHUNKING_VERSION = "structural-context-2000-v1";

export type MarkdownSection = { id: string; headingPath: string[]; text: string };
export type PreparedChunk = {
  text: string;
  sectionIds: string[];
  topics: string[];
  proposedTopics?: string[];
  startSeconds?: number;
  endSeconds?: number;
};
export type PreparedDocument = {
  pageTitle: string;
  sections: MarkdownSection[];
  chunks: PreparedChunk[];
};

type Block = { text: string; level?: number; section: MarkdownSection };
const label = (text: string) => text.trim().replace(/\s+/g, " ");

/** Parse direct section ownership before packing; headings in fences stay content. */
export function prepareMarkdown(markdown: string, pageTitle?: string, targetChars = 2000): PreparedDocument {
  if (!Number.isInteger(targetChars) || targetChars < 1) throw new Error("Chunk target must be a positive integer");
  const maxChars = Math.round((targetChars * 5) / 3);
  const lines = markdown.split(/\r\n?|\n/);
  const firstLine = lines.findIndex((line) => !!line.trim());
  const firstHeading = /^ {0,3}#[ \t]+(.+)$/.exec(lines[firstLine] ?? "");
  const title = label(pageTitle ?? firstHeading?.[1].replace(/[ \t]+#+[ \t]*$/, "") ?? "");
  if (firstLine < 0) return { pageTitle: title, sections: [], chunks: [] };
  const sections: MarkdownSection[] = [{ id: "s0", headingPath: [], text: "" }];
  const blocks: Block[] = [];
  let section = sections[0];
  let ancestry: { level: number; title: string }[] = [];
  let paragraph: string[] = [];
  let fence = "";
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) {
      blocks.push({ text, section });
      section.text += `${section.text ? "\n\n" : ""}${text}`;
    }
    paragraph = [];
  };

  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      paragraph.push(line);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = "";
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      paragraph.push(line);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const headingTitle = label(heading[2].replace(/[ \t]+#+[ \t]*$/, ""));
      if (!(index === firstLine && level === 1 && headingTitle === title)) {
        ancestry = ancestry.filter((item) => item.level < level);
        ancestry.push({ level, title: headingTitle });
        section = { id: `s${sections.length}`, headingPath: ancestry.map((item) => item.title), text: "" };
        sections.push(section);
      }
      blocks.push({ text: line.trim(), level, section });
    } else if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();

  const context = (owner: MarkdownSection) => [
    title ? `Page: ${title}` : "",
    owner.headingPath.length ? `Topic: ${owner.headingPath.join(" > ")}` : "",
  ].filter(Boolean).join("\n");
  for (const owner of sections) {
    if (context(owner).length + 2 >= maxChars) throw new Error("Heading context exceeds the chunk size budget");
  }

  const chunks: PreparedChunk[] = [];
  let current: PreparedChunk | undefined;
  let contextOnly = false;
  const flushChunk = () => {
    if (current?.text) chunks.push(current);
    current = undefined;
    contextOnly = false;
  };
  const start = (owner: MarkdownSection, text = "") => {
    const prefix = context(owner);
    current = { text: [prefix, text].filter(Boolean).join("\n\n"), sectionIds: [owner.id], topics: [] };
    contextOnly = !text;
  };
  const append = (text: string, owner: MarkdownSection) => {
    if (!current) start(owner, text);
    else {
      current.text += `${current.text ? "\n\n" : ""}${text}`;
      if (!current.sectionIds.includes(owner.id)) current.sectionIds.push(owner.id);
      contextOnly = false;
    }
  };

  for (const block of blocks) {
    if (block.level) {
      if (current && (block.level === 1 || current.text.length >= targetChars * 0.5 || current.text.length + 2 + block.text.length > maxChars)) flushChunk();
      if (current) append(block.text, block.section);
      else start(block.section);
      continue;
    }
    let text = block.text;
    if (current && current.text.length + 2 + text.length <= maxChars) {
      append(text, block.section);
      continue;
    }
    if (current) {
      if (contextOnly && current.sectionIds.length === 1 && current.sectionIds[0] === block.section.id) current = undefined;
      else flushChunk();
    }
    const prefix = context(block.section);
    const budget = maxChars - (prefix ? prefix.length + 2 : 0);
    while (text.length > budget) {
      const sentenceEnd = text.lastIndexOf(". ", budget - 1);
      const cut = sentenceEnd > budget / 2 ? sentenceEnd + 1 : budget;
      start(block.section, text.slice(0, cut).trim());
      flushChunk();
      text = text.slice(cut).trim();
    }
    if (text) append(text, block.section);
  }
  flushChunk();
  return { pageTitle: title, sections, chunks };
}
