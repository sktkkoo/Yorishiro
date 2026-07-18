import { describe, expect, it } from "vitest";
import { resolvePersonaAvatarVrm } from "./avatar-vrm";

describe("resolvePersonaAvatarVrm", () => {
  const userEntry = {
    origin: "user" as const,
    entryPath: "/home/u/.yorishiro/packs/miko/persona.js",
  };

  it("user pack dir の avatar.vrm が有効なら絶対パスを返す", async () => {
    const probed: string[] = [];
    const result = await resolvePersonaAvatarVrm(
      {
        getEntry: () => userEntry,
        probeVrm: async (path) => {
          probed.push(path);
          return true;
        },
      },
      "miko",
    );
    expect(result).toBe("/home/u/.yorishiro/packs/miko/avatar.vrm");
    expect(probed).toEqual(["/home/u/.yorishiro/packs/miko/avatar.vrm"]);
  });

  it("avatar.vrm が無ければ null（姿は引き継ぎ）", async () => {
    const result = await resolvePersonaAvatarVrm(
      { getEntry: () => userEntry, probeVrm: async () => false },
      "miko",
    );
    expect(result).toBeNull();
  });

  it("bundled persona は同梱宣言を持たないので null", async () => {
    const result = await resolvePersonaAvatarVrm(
      {
        getEntry: () => ({ origin: "bundled" as const }),
        probeVrm: async () => {
          throw new Error("must not probe bundled");
        },
      },
      "yori",
    );
    expect(result).toBeNull();
  });

  it("未登録 persona / entryPath 無しは null", async () => {
    const deps = {
      probeVrm: async () => {
        throw new Error("must not probe");
      },
    };
    expect(
      await resolvePersonaAvatarVrm({ ...deps, getEntry: () => undefined }, "ghost"),
    ).toBeNull();
    expect(
      await resolvePersonaAvatarVrm(
        { ...deps, getEntry: () => ({ origin: "user" as const }) },
        "x",
      ),
    ).toBeNull();
  });

  it("avatar.vrm が存在するのに不正なら probe の throw を伝播する", async () => {
    await expect(
      resolvePersonaAvatarVrm(
        {
          getEntry: () => userEntry,
          probeVrm: async () => {
            throw new Error("VRM ファイルのGLBヘッダーが不正です");
          },
        },
        "miko",
      ),
    ).rejects.toThrow(/GLB/);
  });
});
