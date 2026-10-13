import { fromMarkdown } from "mdast-util-from-markdown";

type Root = ReturnType<typeof fromMarkdown>;
type Node = Root | Root["children"][number];
type Image = Extract<Node, { type: "image" | "imageReference" }>;

function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>!|&]/g, "\\$&");
}

/** Replace image nodes in the original source, leaving other Markdown untouched. */
export function markdownImagesToLinks(markdown: string): string {
  // Telegram parses Markdown inside details; hide its tags without changing source offsets.
  const source = markdown.replace(/<\/?(?:details|summary)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi,
    (tag) => tag.replace(/[^\r\n]/g, " "));
  const root = fromMarkdown(source);
  const definitions = new Map<string, string>();
  const edits: { start: number; end: number; text: string }[] = [];
  function collectDefinitions(node: Node): void {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if ("children" in node) node.children.forEach(collectDefinitions);
  }
  collectDefinitions(root);

  function imageLink(node: Image, url: string): string {
    if (/^https?:\/\//i.test(url)) {
      const link = markdown.slice(node.position!.start.offset! + 1, node.position!.end.offset!);
      return node.alt?.trim() ? link : link.replace(/^\[[^\]]*\]/, "[图片]");
    }
    return `${escapeText(node.alt?.trim() ? node.alt : "图片")}（${escapeText(url)}）`;
  }
  function visit(node: Node, linkedImages?: string[]): void {
    if (node.type === "image" || node.type === "imageReference") {
      const url = node.type === "image" ? node.url : definitions.get(node.identifier)!;
      // Telegram uses image syntax for inline emoji and dates too; those are not photo media.
      if (/^tg:\/\/(?:emoji|time)\?/i.test(url)) return;
      const link = imageLink(node, url);
      edits.push({
        start: node.position!.start.offset!, end: node.position!.end.offset!,
        text: linkedImages ? escapeText(node.alt?.trim() ? node.alt : "图片") : link,
      });
      linkedImages?.push(link);
    } else if (node.type === "link" || node.type === "linkReference") {
      const images: string[] = [];
      node.children.forEach((child) => visit(child, images));
      if (images.length) {
        const end = node.position!.end.offset!;
        edits.push({ start: end, end, text: `（图片：${images.join("、")}）` });
      }
    } else if ("children" in node) {
      node.children.forEach((child) => visit(child, linkedImages));
    }
  }
  visit(root);
  // Apply edits from the end so source offsets remain valid; replacements precede insertions at the same offset.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const edit of edits) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  return markdown;
}
