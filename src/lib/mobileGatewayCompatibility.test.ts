import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, TurnSettings } from "@codex-board/protocol";
import { TurnSettingsSync } from "@codex-board/protocol";
import { BoardApi } from "../../apps/mobile/src/api";
import { loadLegacyTurnSettings, saveLegacyTurnSettings } from "../../apps/mobile/src/connection";

vi.mock("../../apps/mobile/src/connection",()=>({loadLegacyTurnSettings:vi.fn(),saveLegacyTurnSettings:vi.fn()}));

const legacyBoard={categories:["WIP"],projects:["C:\\work"],approvalMode:"auto",revision:4};
const board=(revision:number,settings:TurnSettings):BoardConfig=>({...legacyBoard,approvalMode:"auto",revision,turnSettings:settings});
const reply=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{"Content-Type":"application/json"}});

describe("OTA compatibility with installed desktop gateways",()=>{
  beforeEach(()=>{vi.mocked(loadLegacyTurnSettings).mockResolvedValue({});vi.mocked(saveLegacyTurnSettings).mockResolvedValue(undefined);});
  afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});

  it("keeps model choices on the phone when the gateway has no shared settings endpoint",async()=>{
    const fetch=vi.fn().mockImplementation(()=>Promise.resolve(reply(legacyBoard)));
    vi.stubGlobal("fetch",fetch);
    const api=new BoardApi({baseUrl:"http://fixture",token:"fixture"});
    const store=new TurnSettingsSync(patch=>api.updateTurnSettings(patch));
    store.receive(await api.board());
    await store.update({model:"chosen",effort:"high"});
    store.receive(await api.board());
    expect(api.sharedTurnSettings).toBe(false);
    expect(await store.flush()).toMatchObject({model:"chosen",effort:"high"});
    expect(saveLegacyTurnSettings).toHaveBeenCalledWith("http://fixture",{model:"chosen",effort:"high"});
    expect(fetch.mock.calls.every(([url])=>String(url).endsWith("/v1/board"))).toBe(true);
  });

  it("restores choices from SecureStore on an older gateway",async()=>{
    vi.mocked(loadLegacyTurnSettings).mockResolvedValue({model:"restored"});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(reply(legacyBoard)));
    const api=new BoardApi({baseUrl:"http://fixture",token:"fixture"});
    expect((await api.board()).turnSettings.model).toBe("restored");
  });

  it("adopts shared settings after the desktop is upgraded",async()=>{
    let upgraded=false;
    const fetch=vi.fn().mockImplementation(()=>Promise.resolve(reply(upgraded?board(5,{model:"desktop-shared"}):legacyBoard)));
    vi.stubGlobal("fetch",fetch);
    const api=new BoardApi({baseUrl:"http://fixture",token:"fixture"});
    const store=new TurnSettingsSync(patch=>api.updateTurnSettings(patch));
    store.receive(await api.board());
    await store.update({model:"phone-local"});
    upgraded=true;
    store.receive(await api.board());
    expect(api.sharedTurnSettings).toBe(true);
    expect((await store.flush()).model).toBe("desktop-shared");
  });

  it("does not treat authentication failures as an older gateway",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"Invalid credential"}),{status:401})));
    const api=new BoardApi({baseUrl:"http://fixture",token:"fixture"});
    await expect(api.updateTurnSettings({model:"chosen"})).rejects.toThrow("Invalid credential");
    expect(saveLegacyTurnSettings).not.toHaveBeenCalled();
  });

  it("saves a conversation model through its own gateway endpoint", async () => {
    const saved = { ...board(6, { model: "default" }), threadTurnSettings: { "thread-a": { model: "model-a" } } };
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(reply(saved)));
    vi.stubGlobal("fetch", fetch);
    const api = new BoardApi({ baseUrl: "http://fixture", token: "fixture" });
    await api.board();
    expect((await api.updateThreadTurnSettings("thread-a", { model: "model-a" })).threadTurnSettings?.["thread-a"].model).toBe("model-a");
    expect(fetch.mock.calls[1][0]).toBe("http://fixture/v1/threads/thread-a/turn-settings");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ model: "model-a" });
  });
});
