export interface CreateProjectInput {
  kind: "windows" | "wsl";
  path: string;
  distribution?: string;
}

export function projectSetupPreview(input: CreateProjectInput): { cwd: string; error: string | null } {
  const path = input.path.trim();
  if (input.kind === "windows") {
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(path)) return { cwd: "", error: "Enter an absolute Windows folder path." };
    return { cwd: path, error: null };
  }
  const distribution = input.distribution === undefined ? "Debian" : input.distribution.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(distribution)) return { cwd: "", error: "Enter a valid WSL distribution." };
  const relative = path.replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === ".." || /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part))) {
    return { cwd: "", error: "Enter a folder relative to /var/www/ without . or .. segments." };
  }
  return { cwd: `\\\\wsl$\\${distribution}\\var\\www\\${relative.replaceAll("/", "\\")}`, error: null };
}
