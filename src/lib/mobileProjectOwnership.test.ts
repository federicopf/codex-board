import { describe, expect, it } from "vitest";
import type { ProjectCustomer } from "@codex-board/protocol";
import { filterCustomerBoardThreads, projectKey } from "../../apps/mobile/src/projectOwnership";
import { normalizeProjectPath } from "./projects";

describe("mobile customer boards", () => {
  it("matches Windows project paths written with either separator", () => {
    const registered = "C:\\Users\\Asus\\ClientWork\\";
    const threadCwd = "c:/users/asus/clientwork";
    expect(projectKey(registered)).toBe(projectKey(threadCwd));
    expect(projectKey(registered)).toBe(normalizeProjectPath(registered));
  });

  it("keeps WSL project path case consistent with desktop", () => {
    const cwd = "/mnt/c/Users/Asus/ClientWork/";
    expect(projectKey(cwd)).toBe(normalizeProjectPath(cwd));
    expect(projectKey(cwd)).not.toBe(projectKey("/mnt/c/users/asus/clientwork"));
  });

  it("shows owned chats only in their customer board", () => {
    const customers: ProjectCustomer[] = [
      { id: "a", name: "Amati", projectCwd: "C:\\Work\\Project", threadIds: ["owned-a"] },
      { id: "b", name: "Other", projectCwd: "C:\\Work\\Project", threadIds: ["owned-b"] },
    ];
    const threads = [
      { id: "generic", cwd: "c:/work/project" },
      { id: "owned-a", cwd: "C:\\Work\\Project" },
      { id: "owned-b", cwd: "C:/Work/Project/" },
      { id: "another-project", cwd: "C:/Work/Other" },
    ];
    const boardKey = projectKey(customers[0].projectCwd);
    const projectThreads = threads.filter((thread) => projectKey(thread.cwd) === boardKey);
    const projectCustomers = customers.filter((customer) => projectKey(customer.projectCwd) === boardKey);
    expect(filterCustomerBoardThreads(projectThreads, projectCustomers, null).map((thread) => thread.id)).toEqual(["generic"]);
    expect(filterCustomerBoardThreads(projectThreads, projectCustomers, "a").map((thread) => thread.id)).toEqual(["owned-a"]);
    expect(filterCustomerBoardThreads(projectThreads, projectCustomers, "b").map((thread) => thread.id)).toEqual(["owned-b"]);
  });
});
