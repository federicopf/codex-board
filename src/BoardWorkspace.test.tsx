// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BoardWorkspace, type BoardWorkspaceProps } from "./BoardWorkspace";

afterEach(cleanup);

function workspaceProps(): BoardWorkspaceProps {
  const noop = vi.fn();
  return {
    project: "/work/amati", generalView: "all", favoriteIds: new Set(), customerId: null,
    customers: [{ id: "content", name: "Amati Content", projectCwd: "/work/amati", threadIds: [] }],
    search: "", projects: [{ key: "/work/amati", label: "Amati", cwd: "/work/amati" }], archivedProjects: [],
    projectStats: {}, displayedCategories: [], filteredThreads: [], visibleThreadCount: 0,
    workingCount: 0, pendingIds: new Set(), workingIds: new Set(), queues: {}, notifications: [],
    refreshing: false, onProjectChange: noop, onGeneralViewChange: noop, onToggleFavorite: noop,
    onCustomerChange: noop, onCreateCustomer: noop, onAssignCustomer: noop, onSearchChange: noop,
    onRefresh: noop, onCategories: noop, onAutomations: noop, onNewTask: noop, onNewProject: noop,
    onSettings: noop, onGuide: noop, onInbox: noop, onRemote: noop, onOpen: noop, onMove: noop,
    onFork: noop, onRename: noop, onRenameThread: noop, onDelete: noop, onStop: noop,
    onDeleteProject: vi.fn(), onRenameProject: vi.fn(), onArchiveProject: vi.fn(), onRestoreProject: vi.fn(), onDeleteCustomer: vi.fn(), rateLimits: null,
  };
}

it("keeps customer dropdown separate from project rename and removal actions", () => {
  const props = workspaceProps();
  render(<BoardWorkspace {...props}/>);
  expect(screen.getByRole("button", { name: "Collapse Amati customers" })).toHaveProperty("ariaExpanded", "true");
  expect(screen.queryByRole("button", { name: "Remove project" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Actions for project Amati" }));
  expect(screen.getByRole("dialog", { name: "Project actions" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
  expect(props.onRenameProject).toHaveBeenCalledExactlyOnceWith("/work/amati");
  expect(props.onDeleteProject).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Actions for project Amati" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
  expect(props.onDeleteProject).toHaveBeenCalledExactlyOnceWith("/work/amati");
});

it("archives from project actions and restores from the archived dropdown", () => {
  const props = workspaceProps();
  const view = render(<BoardWorkspace {...props}/>);
  fireEvent.click(screen.getByRole("button", { name: "Actions for project Amati" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
  expect(props.onArchiveProject).toHaveBeenCalledExactlyOnceWith("/work/amati");
  expect(props.onDeleteProject).not.toHaveBeenCalled();

  view.rerender(<BoardWorkspace {...props} projects={[]} archivedProjects={props.projects} project="__all_projects__"/>);
  fireEvent.click(screen.getByRole("button", { name: /Archived projects/ }));
  fireEvent.click(screen.getByRole("button", { name: "Restore project Amati" }));
  expect(props.onRestoreProject).toHaveBeenCalledExactlyOnceWith("/work/amati");
  fireEvent.click(screen.getByRole("button", { name: "Actions for project Amati" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore project" }));
  expect(props.onRestoreProject).toHaveBeenCalledTimes(2);
});

it("opens customer removal in a popup and closes it with Escape", () => {
  const props = workspaceProps();
  render(<BoardWorkspace {...props}/>);
  fireEvent.click(screen.getByRole("button", { name: "Actions for customer Amati Content" }));
  expect(screen.getByRole("dialog", { name: "Customer actions" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Customer actions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Actions for customer Amati Content" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove customer" }));
  expect(props.onDeleteCustomer).toHaveBeenCalledExactlyOnceWith("content");
});
