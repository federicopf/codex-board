import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { formatCodexDirectives } from "@codex-board/protocol";
export { formatCodexDirectives } from "@codex-board/protocol";

export function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children: label }) => (
            <a
              href={href}
              title={href}
              onClick={(event) => event.preventDefault()}
            >
              {label}
            </a>
          ),
        }}
      >
        {formatCodexDirectives(children)}
      </ReactMarkdown>
    </div>
  );
}
