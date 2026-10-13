import { describe, expect, it } from "vitest";
import { markdownImagesToLinks } from "../src/markdown-images.js";

describe("Markdown image fallback", () => {
  it("preserves formatting and image destinations while giving empty labels visible text", () => {
    const markdown = '**bold**\n\n![](https://example.com/a(b).png "标题")\n\n[![ \t](https://example.com/thumb.png)](https://example.com/page)![next](https://example.com/next.png)';
    expect(markdownImagesToLinks(markdown)).toBe('**bold**\n\n[图片](https://example.com/a(b).png "标题")\n\n[图片](https://example.com/page)（图片：[图片](https://example.com/thumb.png)）[next](https://example.com/next.png)');
  });

  it("converts body images inside details while keeping code and escaped examples intact", () => {
    const image = "![图](https://example.com/image.png)";
    const markdown = [
      '<details open><summary title="a > b">图片</summary>', image,
      "", `\`<details>${image}</details>\``, "", "```markdown", image, "```",
      "", `    ${image}`, "", `\\${image}`, "", `> ${image}`, "", `- ${image}`, "</details>",
    ].join("\r\n");
    const expected = markdown.replace(image, "[图](https://example.com/image.png)")
      .replace(`> ${image}`, "> [图](https://example.com/image.png)")
      .replace(`- ${image}`, "- [图](https://example.com/image.png)");
    expect(markdownImagesToLinks(markdown)).toBe(expected);
  });

  it("resolves reference images, preserves custom emoji, and shows unsupported addresses as text", () => {
    const markdown = '![][pic]\n\n[![引用][pic]][page]\n\n![红点](data:image/png;base64,AAAA) ![👍](tg://emoji?id=123)\n\n[pic]: https://example.com/pic.png "标题"\n[page]: https://example.com/page';
    expect(markdownImagesToLinks(markdown)).toBe('[图片][pic]\n\n[引用][page]（图片：[引用][pic]）\n\n红点（data:image/png;base64,AAAA） ![👍](tg://emoji?id=123)\n\n[pic]: https://example.com/pic.png "标题"\n[page]: https://example.com/page');
  });
});
