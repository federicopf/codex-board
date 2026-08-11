import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders common chat formatting", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent>{"## Result\n\n- **done**\n- `npm test`"}</MarkdownContent>,
    );
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>done</strong>");
    expect(html).toContain("<code>npm test</code>");
  });

  it("supports GFM task lists and tables", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent>{"- [x] shipped\n\n| A | B |\n| - | - |\n| 1 | 2 |"}</MarkdownContent>,
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
  });
});
