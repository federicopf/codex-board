import { describe, expect, it } from "vitest";
import { projectSetupPreview } from "@codex-board/protocol";

describe("project setup paths", () => {
  it("builds the WSL path under /var/www/ from a relative path", () => {
    expect(projectSetupPreview({ kind: "wsl", distribution: "Debian", path: "personal-projects/tkss-valencia" })).toEqual({ cwd: "\\\\wsl$\\Debian\\var\\www\\personal-projects\\tkss-valencia", error: null });
  });

  it("rejects paths outside the WSL base and invalid distributions", () => {
    for (const path of ["/var/www/client", "../outside", "client/../outside", "client//nested"]) {
      expect(projectSetupPreview({ kind: "wsl", distribution: "Debian", path }).error).toBeTruthy();
    }
    expect(projectSetupPreview({ kind: "wsl", distribution: "--bad", path: "client" }).error).toBeTruthy();
  });

  it("requires an absolute Windows path", () => {
    expect(projectSetupPreview({ kind: "windows", path: "Projects/demo" }).error).toBeTruthy();
    expect(projectSetupPreview({ kind: "windows", path: "C:\\Projects\\demo" }).cwd).toBe("C:\\Projects\\demo");
  });
});
