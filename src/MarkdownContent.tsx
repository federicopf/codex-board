import ReactMarkdown from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { formatCodexDirectives } from "@codex-board/protocol";
export { formatCodexDirectives } from "@codex-board/protocol";

function localPathToFileUrl(path: string) {
  const normalized = path.trim().replaceAll("\\", "/");
  return `file:///${encodeURI(normalized.replace(/^([A-Za-z]):/, "$1:"))}`;
}

function linkifyLocalPaths(source: string) {
  let fenced = false;
  return source.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return line;
    }
    if (fenced || line.includes("](") || line.includes("<http")) return line;
    return line.replace(/(^|[\s(:])([A-Za-z]:\\[^<>\"|?*\r\n]+|\\\\[^<>\"|?*\r\n]+)/g, (match, prefix, rawPath) => {
      const path = rawPath.replace(/[.,;:)]+$/, "");
      if (!path || path.includes("\\n")) return match;
      return `${prefix}[${path}](${localPathToFileUrl(path)})`;
    });
  }).join("\n");
}

export function MarkdownContent({ children }: { children: string }) {
  const openLink = (href: string | undefined) => {
    if (!href) return;
    if (href.startsWith("file://")) {
      void invoke("open_external_url", { url: href }).catch(() => {
        window.open(href, "_blank", "noopener,noreferrer");
      });
      return;
    }
    if (!/^https?:\/\//i.test(href)) return;
    void invoke("open_external_url", { url: href }).catch(() => {
      window.open(href, "_blank", "noopener,noreferrer");
    });
  };

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={(url) => url}
        components={{
          a: ({ href, children: label }) => (
            <a
              href={href}
              title={href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                openLink(href);
              }}
            >
              {label}
            </a>
          ),
        }}
      >
        {linkifyLocalPaths(formatCodexDirectives(children))}
      </ReactMarkdown>
    </div>
  );
}
