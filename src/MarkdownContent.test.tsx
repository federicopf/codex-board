import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatCodexDirectives, MarkdownContent } from "./MarkdownContent";

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

  it("turns Codex git directives into readable operation summaries", () => {
    const source = "::git-stage{cwd=\"/var/www/travelmanager\"}\\\n::git-commit{cwd=\"/var/www/travelmanager\"}\\\n::git-push{cwd=\"/var/www/travelmanager\" branch=\"main\"}";
    const formatted = formatCodexDirectives(source);
    expect(formatted).not.toContain("::git-");
    expect(formatted).toContain("**Stage changes**");
    expect(formatted).toContain("branch `main`");
    const html = renderToStaticMarkup(<MarkdownContent>{source}</MarkdownContent>);
    expect(html).toContain("<li>");
    expect(html).toContain("Push changes");
  });
});
