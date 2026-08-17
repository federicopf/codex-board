import { describe, expect, it } from "vitest";
import { categoryNameError, createCategory, moveCategory, moveCategoryToPosition, orderVisibleCategories, reconcileCategoryOrder, renameCategory } from "./categoryOrder";

describe("category order", () => {
  it("keeps the user's order and appends newly discovered categories", () => {
    expect(reconcileCategoryOrder(["WIP", "To Plan"], ["To Plan", "Review", "WIP"]))
      .toEqual(["WIP", "To Plan", "Review"]);
  });

  it("keeps locally created categories when they are empty", () => {
    expect(reconcileCategoryOrder(["Ideas", "WIP"], ["WIP", "Done"]))
      .toEqual(["Ideas", "WIP", "Done"]);
  });

  it("creates and renames local categories", () => {
    expect(createCategory(["WIP"], "Ideas")).toEqual(["WIP", "Ideas"]);
    expect(renameCategory(["WIP", "Ideas"], "Ideas", "Next")).toEqual(["WIP", "Next"]);
  });

  it("moves a category directly to an absolute position", () => {
    expect(moveCategoryToPosition(["A", "B", "C", "D"], "D", 1)).toEqual(["A", "D", "B", "C"]);
    expect(moveCategoryToPosition(["A", "B", "C"], "A", 99)).toEqual(["B", "C", "A"]);
  });

  it("validates category names", () => {
    expect(categoryNameError("", ["WIP"])).toBeTruthy();
    expect(categoryNameError("Bad - Name", ["WIP"])).toBeTruthy();
    expect(categoryNameError("WIP", ["WIP"])).toBeTruthy();
    expect(categoryNameError("WIP", ["WIP"], "WIP")).toBeNull();
  });

  it("applies the global order to a filtered project", () => {
    expect(orderVisibleCategories(["Review", "WIP"], ["To Plan", "WIP", "Review", "Uncategorized"]))
      .toEqual(["WIP", "Review"]);
  });

  it("moves a category to the selected position", () => {
    expect(moveCategory(["WIP", "Review", "Done"], "Done", "WIP"))
      .toEqual(["Done", "WIP", "Review"]);
  });
});
