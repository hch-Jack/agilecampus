import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, getTeamMembership, listMyTeams } from "@/lib/team";
import {
  buildPersonalTools,
  COMMIT_TOOL_NAMES,
  CREATE_TEAM_TOOL,
  JOIN_TEAM_TOOL,
  WRITE_TOOL_NAMES,
} from "@/lib/agent/tools";
import { commitPersonalDraft } from "@/lib/agent/commit";
import { resetDb } from "./helpers";

/**
 * 工作台助手的「建团队 / 加入团队」。
 *
 * 两件都是两段式写操作：工具只产草案，确认后经 `commitPersonalDraft` 落库。
 * 这里钉住的是 **id / 邀请码只能来自用户与库、绝不进项目写工具面**。
 */

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

const opts = {} as never;

describe("create_team", () => {
  beforeEach(resetDb);

  it("只产草案，确认后建团并把发起人设为 admin", async () => {
    const user = await makeUser("owner@example.com");
    const tools = buildPersonalTools(user.id);

    const env = (await tools.create_team.execute!(
      { name: "  东吴实验室  " },
      opts,
    )) as { __draft: true; tool: string; draft: { name: string } };
    expect(env).toEqual({
      __draft: true,
      tool: CREATE_TEAM_TOOL,
      draft: { name: "东吴实验室" },
    });

    // 拟稿不落库
    expect(await listMyTeams(user.id)).toHaveLength(0);

    await commitPersonalDraft(user.id, CREATE_TEAM_TOOL, env.draft);
    const teams = await listMyTeams(user.id);
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ name: "东吴实验室", role: "admin" });
  });

  it("空名在拟稿期就被拒", async () => {
    const user = await makeUser("owner@example.com");
    const tools = buildPersonalTools(user.id);
    await expect(tools.create_team.execute!({ name: "   " }, opts)).rejects.toThrow(
      "团队名称不能为空",
    );
  });

  it("落库口 trim 后落库，空名同样拒绝", async () => {
    const user = await makeUser("owner@example.com");
    await expect(
      commitPersonalDraft(user.id, CREATE_TEAM_TOOL, { name: "   " }),
    ).rejects.toThrow("请填写团队名称");

    await commitPersonalDraft(user.id, CREATE_TEAM_TOOL, { name: "  赤壁组  " });
    expect((await listMyTeams(user.id))[0]?.name).toBe("赤壁组");
  });
});

describe("join_team", () => {
  beforeEach(resetDb);

  it("凭邀请码拟草案，卡上带团队名；确认后以注册身份入团", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("student@example.com");
    const tools = buildPersonalTools(student.id);

    const env = (await tools.join_team.execute!(
      { inviteCode: `  ${team.inviteCode}  ` },
      opts,
    )) as { __draft: true; tool: string; draft: { inviteCode: string; teamName: string } };
    expect(env).toEqual({
      __draft: true,
      tool: JOIN_TEAM_TOOL,
      draft: { inviteCode: team.inviteCode, teamName: "东吴实验室" },
    });
    // 拟稿不落库
    expect(await getTeamMembership(student.id, team.id)).toBeNull();

    await commitPersonalDraft(student.id, JOIN_TEAM_TOOL, env.draft);
    expect(await getTeamMembership(student.id, team.id)).toMatchObject({ role: "student" });
  });

  it("邀请码无效 / 为空都在拟稿期报错", async () => {
    const user = await makeUser("student@example.com");
    const tools = buildPersonalTools(user.id);
    await expect(tools.join_team.execute!({ inviteCode: "nope" }, opts)).rejects.toThrow(
      "邀请码无效",
    );
    await expect(tools.join_team.execute!({ inviteCode: "   " }, opts)).rejects.toThrow(
      "请提供团队邀请码",
    );
  });

  it("已在团队中时不重复产草案", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const tools = buildPersonalTools(owner.id);
    await expect(
      tools.join_team.execute!({ inviteCode: team.inviteCode }, opts),
    ).rejects.toThrow("你已经在该团队");
  });

  it("落库那一刻再校一次：码失效则拒绝", async () => {
    const user = await makeUser("student@example.com");
    await expect(
      commitPersonalDraft(user.id, JOIN_TEAM_TOOL, { inviteCode: "stale-code" }),
    ).rejects.toThrow("邀请码无效");
  });

  it("重复确认同一张卡时由 joinTeam 挡住", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("student@example.com");

    await commitPersonalDraft(student.id, JOIN_TEAM_TOOL, { inviteCode: team.inviteCode });
    await expect(
      commitPersonalDraft(student.id, JOIN_TEAM_TOOL, { inviteCode: team.inviteCode }),
    ).rejects.toThrow("已在该团队中");
  });
});

describe("工具面归属", () => {
  it("建团/入团只进 COMMIT_TOOL_NAMES，不进项目写工具面", () => {
    expect(COMMIT_TOOL_NAMES).toContain(CREATE_TEAM_TOOL);
    expect(COMMIT_TOOL_NAMES).toContain(JOIN_TEAM_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(CREATE_TEAM_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(JOIN_TEAM_TOOL);
  });
});
