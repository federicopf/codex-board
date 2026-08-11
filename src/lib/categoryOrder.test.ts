import { describe, expect, it } from "vitest";
import { moveCategory, orderVisibleCategories, reconcileCategoryOrder } from "./categoryOrder";

describe("category order", () => {
  it("keeps the user's order and appends newly discovered categories", () => {
    expect(reconcileCategoryOrder(["WIP", "To Plan"], ["To Plan", "Review", "WIP"]))
      .toEqual(["WIP", "To Plan", "Review"]);
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
