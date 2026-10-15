import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import {
  CONTEXT_MAX_ITEMS,
  countMyPersonalContext,
  createPersonalContext,
  deletePersonalContext,
  listMyPersonalContext,
  listProjectMembersSharedContext,
  normalizeContextContent,
  setPersonalContextVisibility,
} from "@/lib/personal-context";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const outsider = await makeUser("outsider@example.com");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  return { owner, team, student, outsider, project };
}

describe("normalizeContextContent", () => {
  it("折 CRLF、剔零宽与控制字符，保留换行，再 trim", () => {
    expect(normalizeContextContent("  研究方向\r\n遥感分割  ")).toBe("研究方向\n遥感分割");
    expect(normalizeContextContent("​隐形﻿字符")).toBe("隐形字符");
    expect(normalizeContextContent("a\u0000b\u001Fc")).toBe("abc");
    expect(normalizeContextContent("多行\n\n保持")).toBe("多行\n\n保持");
  });
});

describe("个人上下文", () => {
  beforeEach(resetDb);

  it("手填一条：默认项目可见、来源 manual，只归自己", async () => {
    const { student, owner } = await scene();
    await createPersonalContext(student.id, [{ content: "我在做遥感图像分割" }]);

    const mine = await listMyPersonalContext(student.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].content).toBe("我在做遥感图像分割");
    expect(mine[0].visibility).toBe("shared");
    expect(mine[0].source).toBe("manual");
    // 别人的列表里没有它
    expect(await listMyPersonalContext(owner.id)).toHaveLength(0);
  });

  it("空内容与超长内容被拒", async () => {
    const { student } = await scene();
    await expect(createPersonalContext(student.id, [{ content: "   " }])).rejects.toThrow(
      "不能为空",
    );
    await expect(
      createPersonalContext(student.id, [{ content: "字".repeat(1001) }]),
    ).rejects.toThrow("最多 1000 字");
    expect(await countMyPersonalContext(student.id)).toBe(0);
  });

  it("超配额整批拒绝，不留半截", async () => {
    const { student } = await scene();
    await createPersonalContext(
      student.id,
      Array.from({ length: CONTEXT_MAX_ITEMS }, (_, i) => ({ content: `第 ${i} 条` })),
    );
    expect(await countMyPersonalContext(student.id)).toBe(CONTEXT_MAX_ITEMS);

    await expect(
      createPersonalContext(student.id, [{ content: "多出来的一条" }, { content: "又一条" }]),
    ).rejects.toThrow("最多 50 条");
    expect(await countMyPersonalContext(student.id)).toBe(CONTEXT_MAX_ITEMS);
  });

  it("删/改只能动自己的：动别人的报不存在，且原条目无损", async () => {
    const { student, owner } = await scene();
    await createPersonalContext(owner.id, [{ content: "管理员的自留地", visibility: "private" }]);
    const [entry] = await listMyPersonalContext(owner.id);

    await expect(deletePersonalContext(student.id, entry.id)).rejects.toThrow("上下文不存在");
    await expect(
      setPersonalContextVisibility(student.id, entry.id, "shared"),
    ).rejects.toThrow("上下文不存在");

    const still = await listMyPersonalContext(owner.id);
    expect(still).toHaveLength(1);
    expect(still[0].visibility).toBe("private");
  });

  it("改可见性：自己的条目能从项目可见退回仅自己", async () => {
    const { student } = await scene();
    await createPersonalContext(student.id, [{ content: "私事" }]);
    const [entry] = await listMyPersonalContext(student.id);
    expect(entry.visibility).toBe("shared");

    await setPersonalContextVisibility(student.id, entry.id, "private");
    expect((await listMyPersonalContext(student.id))[0].visibility).toBe("private");
  });
});

describe("项目助手的成员上下文口径", () => {
  beforeEach(resetDb);

  it("只收项目可见的条目，且按团队成员聚合", async () => {
    const { student, owner, project } = await scene();
    await createPersonalContext(student.id, [
      { content: "学生：在准备中期答辩" },
      { content: "学生的私事", visibility: "private" },
    ]);
    await createPersonalContext(owner.id, [{ content: "管理员：负责排期" }]);

    const rows = await listProjectMembersSharedContext(student.id, project.id);
    // 顺序跟 listTeamMembers 走（它没有 ORDER BY），故这里只比集合
    expect(rows.map((r) => r.name).sort()).toEqual(["owner", "student"]);
    expect(rows.find((r) => r.name === "student")?.entries).toEqual(["学生：在准备中期答辩"]);
    expect(rows.find((r) => r.name === "owner")?.entries).toEqual(["管理员：负责排期"]);
    // private 条目一个字都不能漏出去
    expect(JSON.stringify(rows)).not.toContain("私事");
  });

  it("非成员被拒（快照里的这段同样进不去）", async () => {
    const { outsider, project } = await scene();
    await expect(listProjectMembersSharedContext(outsider.id, project.id)).rejects.toThrow(
      "没有权限",
    );
  });

  it("团队成员之外的条目不会混进来", async () => {
    const { student, owner, project } = await scene();
    const team = await createTeam(owner.id, "别人家的队伍");
    void team;
    const stranger = await makeUser("stranger@example.com");
    await createPersonalContext(stranger.id, [{ content: "外人：与本案无关" }]);

    const rows = await listProjectMembersSharedContext(student.id, project.id);
    expect(rows.map((r) => r.name).sort()).toEqual(["owner", "student"]);
  });
});
