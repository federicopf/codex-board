import ReactMarkdown from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { useEffect, useState } from "react";
import { formatCodexDirectives } from "@codex-board/protocol";
export { formatCodexDirectives } from "@codex-board/protocol";

function fileUrlPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    return url.hostname && url.hostname !== "localhost"
      ? `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`
      : /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1).replaceAll("/", "\\") : pathname;
  } catch { return null; }
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const path = src?.startsWith("file://") ? fileUrlPath(src) : src && (/^(?:\/|[A-Za-z]:\\|\\\\)/.test(src) ? src : null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let active = true;
    void invoke<string>("read_chat_image", { path }).then(value => { if (active) setDataUrl(value); }).catch(() => { if (active) setDataUrl(null); });
    return () => { active = false; };
  }, [path]);
  if (!path) return src ? <img src={src} alt={alt || ""} /> : null;
  return dataUrl ? <img className="chat-markdown-image" src={dataUrl} alt={alt || "Image from Codex"} /> : <span className="chat-generated-image-placeholder">Image unavailable</span>;
}

function localPathToFileUrl(path: string) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? `file://${encodeURI(normalized)}` : `file:///${encodeURI(normalized)}`;
}

function linkifyLocalPaths(source: string) {
  let fenced = false;
  return source.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return line;
    }
    if (fenced || line.includes("](") || line.includes("<http")) return line;
    const windowsPaths = line.replace(/(^|[\s(:])([A-Za-z]:\\[^<>\"|?*\r\n]+|\\\\[^<>\"|?*\r\n]+)/g, (match, prefix, rawPath) => {
      const path = rawPath.replace(/[.,;:)]+$/, "");
      if (!path || path.includes("\\n")) return match;
      return `${prefix}[${path}](${localPathToFileUrl(path)})`;
    });
    const quotedUnixPaths = windowsPaths.replace(/`((?:\/mnt\/[A-Za-z](?:\/|$)|\/(?:home|tmp|workspace|workspaces|root|opt|var)\/)[^`\r\n]+)`/g, (_match, rawPath) => {
      const path = rawPath.replace(/[.,;:)]+$/, "");
      return `[${path}](${localPathToFileUrl(path)})`;
    });
    return quotedUnixPaths.replace(/(^|[\s(:])((?:\/mnt\/[A-Za-z](?:\/|$)|\/(?:home|tmp|workspace|workspaces|root|opt|var)\/)[^<>\"|?*\s]+)/g, (match, prefix, rawPath) => {
      const path = rawPath.replace(/[.,;:)]+$/, "");
      return path ? `${prefix}[${path}](${localPathToFileUrl(path)})` : match;
    });
  }).join("\n");
}

export function MarkdownContent({ children }: { children: string }) {
  const [pathError, setPathError] = useState<string | null>(null);
  const openLink = (href: string | undefined) => {
    if (!href) return;
    setPathError(null);
    if (href.startsWith("/") || /^[A-Za-z]:\\/.test(href) || href.startsWith("\\\\")) {
      void invoke("open_local_path", { path: href }).catch((error: unknown) => {
        setPathError(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (href.startsWith("file://")) {
      const localPath = fileUrlPath(href);
      if (!localPath) return;
      if (!/^[A-Za-z]:\\/.test(localPath) && !localPath.startsWith("\\\\")) {
        void invoke("open_local_path", { path: localPath }).catch((error: unknown) => {
          setPathError(error instanceof Error ? error.message : String(error));
        });
        return;
      }
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
          img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
        }}
      >
        {linkifyLocalPaths(formatCodexDirectives(children))}
      </ReactMarkdown>
      {pathError && <div className="local-path-error" role="alert">Could not open this file from Windows: {pathError}</div>}
    </div>
  );
}
