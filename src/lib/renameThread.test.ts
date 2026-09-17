import { describe,expect,it } from "vitest";
import { threadNameWithTitle } from "@codex-board/protocol";
describe("conversation renaming",()=>{
  it("preserves a custom category and trims the new title",()=>{
    expect(threadNameWithTitle("Review - Old",null," New title ")).toBe("Review - New title");
  });
  it("keeps uncategorized tasks uncategorized",()=>{
    expect(threadNameWithTitle("Old",null,"New")).toBe("New");
    expect(()=>threadNameWithTitle("Old",null,"WIP - New")).toThrow("Use Move");
  });
  it("rejects empty titles",()=>expect(()=>threadNameWithTitle("WIP - Old",null," ")).toThrow("empty"));
});
