import { describe, expect, it } from "vitest";
import { ThreadTurnSettingsSync, TurnSettingsSync, type BoardConfig, type TurnSettings } from "@codex-board/protocol";

const config = (revision: number, turnSettings: TurnSettings): BoardConfig => ({ categories: [], projects: [], approvalMode: "ask", revision, turnSettings });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no)=>{resolve=yes;reject=no;});
  return { promise, resolve, reject };
}

describe("shared desktop/mobile turn preferences",()=>{
  it("accepts remote changes and ignores late snapshots",()=>{
    const store=new TurnSettingsSync(async()=>config(0,{}));
    store.receive(config(4,{model:"desktop-model",effort:"high",serviceTier:"priority"}));
    store.receive(config(6,{model:"mobile-model",effort:"",serviceTier:""}));
    store.receive(config(5,{model:"outdated-model",effort:"high"}));
    expect(store.getSnapshot().settings).toEqual({model:"mobile-model",effort:"",summary:"auto",serviceTier:""});
  });

  it("serializes rapid edits without letting an earlier reply reset the visible selection",async()=>{
    const first=deferred<BoardConfig>();
    const second=deferred<BoardConfig>();
    const writes:TurnSettings[]=[];
    const store=new TurnSettingsSync(patch=>{writes.push(patch);return writes.length===1?first.promise:second.promise;});
    store.receive(config(1,{model:"original"}));
    const modelSave=store.update({model:"chosen",effort:""});
    const effortSave=store.update({effort:"high"});
    await Promise.resolve();
    expect(writes).toEqual([{model:"chosen",effort:""}]);
    store.receive(config(2,{model:"chosen",effort:""}));
    expect(store.getSnapshot().settings.effort).toBe("high");
    first.resolve(config(2,{model:"chosen",effort:""}));
    await modelSave;
    second.resolve(config(3,{model:"chosen",effort:"high"}));
    await effortSave;
    expect(await store.flush()).toMatchObject({model:"chosen",effort:"high"});
    expect(writes).toEqual([{model:"chosen",effort:""},{effort:"high"}]);
  });

  it("rolls back failed saves and refuses to send unconfirmed settings",async()=>{
    const store=new TurnSettingsSync(async()=>{throw new Error("PC disconnected");});
    store.receive(config(1,{model:"saved"}));
    await expect(store.update({model:"unsaved"})).rejects.toThrow("PC disconnected");
    expect(store.getSnapshot().settings.model).toBe("saved");
    await expect(store.flush()).rejects.toThrow("PC disconnected");
    store.receive(config(2,{model:"saved"}));
    expect((await store.flush()).model).toBe("saved");
  });

  it("waits for the pending save before a turn can use it",async()=>{
    const response=deferred<BoardConfig>();
    const store=new TurnSettingsSync(()=>response.promise);
    store.receive(config(1,{model:"old"}));
    const save=store.update({model:"new"});
    const sending=store.flush();
    response.resolve(config(2,{model:"new"}));
    await save;
    expect((await sending).model).toBe("new");
  });
});

describe("per-conversation turn preferences", () => {
  it("changes one thread without changing another and survives board refresh", async () => {
    let saved = config(1, { model: "default-model" });
    const store = new ThreadTurnSettingsSync(async () => saved, async (id, patch) => {
      saved = { ...saved, revision: saved.revision + 1, threadTurnSettings: {
        ...saved.threadTurnSettings,
        [id]: { ...saved.threadTurnSettings?.[id], ...patch },
      } };
      return saved;
    });
    store.receive(saved);
    expect(store.thread("a").getSnapshot().settings.model).toBe("default-model");
    expect(store.thread("b").getSnapshot().settings.model).toBe("default-model");
    await store.thread("a").update({ model: "model-a" });
    expect((await store.thread("a").flush()).model).toBe("model-a");
    expect((await store.thread("b").flush()).model).toBe("default-model");
    store.receive(config(1, { model: "stale-model" }));
    expect(store.thread("a").getSnapshot().settings.model).toBe("model-a");
    const reopened = new ThreadTurnSettingsSync(async () => saved, async () => saved);
    reopened.receive(saved);
    expect(reopened.thread("a").getSnapshot().settings.model).toBe("model-a");
    expect(reopened.thread("b").getSnapshot().settings.model).toBe("default-model");
  });
});
