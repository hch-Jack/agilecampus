import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import {
  createProject,
  updateProject,
  listTeamProjects,
  getProjectForUser,
  createMilestone,
  listProjectMilestones,
} from "@/lib/project";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

// 常用布景：owner(admin) 建团队，student 加入，outsider 在野
async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const outsider = await makeUser("outsider@example.com");
  return { owner, team, student, outsider };
}

describe("createProject", () => {
  beforeEach(resetDb);

  it("admin 可创建项目，默认 active", async () => {
    const { owner, team } = await scene();
    const p = await createProject(owner.id, team.id, {
      name: "赤壁演习",
      description: "冬季学期项目",
      startDate: "2026-09-01",
      endDate: "2027-01-15",
    });
    expect(p.name).toBe("赤壁演习");
    expect(p.status).toBe("active");
    expect(p.teamId).toBe(team.id);
  });

  it("student 建项目被拒（仅 admin）", async () => {
    const { team, student } = await scene();
    await expect(
      createProject(student.id, team.id, { name: "私设项目" }),
    ).rejects.toThrow("没有权限");
  });

  it("开始晚于结束被拒", async () => {
    const { owner, team } = await scene();
    await expect(
      createProject(owner.id, team.id, {
        name: "倒流项目",
        startDate: "2026-09-01",
        endDate: "2026-08-31",
      }),
    ).rejects.toThrow("开始日期不能晚于结束日期");
  });

  it("开始等于结束合法（当日项目），只填一端亦合法", async () => {
    const { owner, team } = await scene();
    const p = await createProject(owner.id, team.id, {
      name: "一日冲刺",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
    });
    expect(p.startDate).toBe("2026-09-01");
    const q = await createProject(owner.id, team.id, {
      name: "无终点项目",
      startDate: "2026-09-01",
    });
    expect(q.endDate).toBeNull();
  });

  it("非法日期格式被拒（含不真实存在的日子）", async () => {
    const { owner, team } = await scene();
    await expect(
      createProject(owner.id, team.id, { name: "甲", startDate: "2026/09/01" }),
    ).rejects.toThrow("日期格式不正确");
    await expect(
      createProject(owner.id, team.id, { name: "乙", endDate: "2026-02-30" }),
    ).rejects.toThrow("日期格式不正确");
  });
});

describe("updateProject 起止日期校验", () => {
  beforeEach(resetDb);

  it("把结束改得早于既有开始被拒", async () => {
    const { owner, team } = await scene();
    const p = await createProject(owner.id, team.id, {
      name: "甲计划",
      startDate: "2026-09-01",
    });
    await expect(
      updateProject(owner.id, p.id, { endDate: "2026-08-31" }),
    ).rejects.toThrow("开始日期不能晚于结束日期");
  });

  it("把开始改得晚于既有结束被拒", async () => {
    const { owner, team } = await scene();
    const p = await createProject(owner.id, team.id, {
      name: "甲计划",
      endDate: "2026-08-31",
    });
    await expect(
      updateProject(owner.id, p.id, { startDate: "2026-09-01" }),
    ).rejects.toThrow("开始日期不能晚于结束日期");
  });

  it("存量倒挂数据：只改名不受误伤，清一端可解", async () => {
    const { owner, team } = await scene();
    // 直插模拟修复前落库的倒挂行（createProject 现已拒之门外）
    const [p] = await db
      .insert(projects)
      .values({
        teamId: team.id,
        name: "存量倒挂",
        startDate: "2026-09-01",
        endDate: "2026-08-31",
      })
      .returning();
    const renamed = await updateProject(owner.id, p.id, { name: "改名不受误伤" });
    expect(renamed.name).toBe("改名不受误伤");
    const cleared = await updateProject(owner.id, p.id, { endDate: null });
    expect(cleared.endDate).toBeNull();
  });

  it("两端齐改且合法通过", async () => {
    const { owner, team } = await scene();
    const p = await createProject(owner.id, team.id, {
      name: "甲计划",
      startDate: "2026-09-10",
    });
    const fixed = await updateProject(owner.id, p.id, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    expect(fixed.startDate).toBe("2026-09-01");
    expect(fixed.endDate).toBe("2026-09-30");
  });

  it("只改名的请求不因触及日期之外的字段受日期校验影响", async () => {
    const { owner, team } = await scene();
    const p = await createProject(owner.id, team.id, { name: "甲计划" });
    const updated = await updateProject(owner.id, p.id, { name: "乙计划" });
    expect(updated.name).toBe("乙计划");
  });

  it("student 改项目被拒（仅 admin）", async () => {
    const { owner, team, student } = await scene();
    const p = await createProject(owner.id, team.id, { name: "甲计划" });
    await expect(
      updateProject(student.id, p.id, { name: "越权改名" }),
    ).rejects.toThrow("没有权限");
  });
});

describe("listTeamProjects", () => {
  beforeEach(resetDb);

  it("团队成员可列出团队项目", async () => {
    const { owner, team, student } = await scene();
    await createProject(owner.id, team.id, { name: "甲计划" });
    await createProject(owner.id, team.id, { name: "乙计划" });
    const list = await listTeamProjects(student.id, team.id);
    expect(list).toHaveLength(2);
  });

  it("非成员被拒", async () => {
    const { owner, team, outsider } = await scene();
    await createProject(owner.id, team.id, { name: "甲计划" });
    await expect(listTeamProjects(outsider.id, team.id)).rejects.toThrow("没有权限");
  });
});

describe("getProjectForUser", () => {
  beforeEach(resetDb);

  it("成员取得项目与自身角色", async () => {
    const { owner, team, student } = await scene();
    const p = await createProject(owner.id, team.id, { name: "甲计划" });
    const access = await getProjectForUser(student.id, p.id);
    expect(access?.project.id).toBe(p.id);
    expect(access?.role).toBe("student");
  });

  it("非成员得 null（不泄露存在性）", async () => {
    const { owner, team, outsider } = await scene();
    const p = await createProject(owner.id, team.id, { name: "甲计划" });
    expect(await getProjectForUser(outsider.id, p.id)).toBeNull();
  });

  it("项目不存在得 null", async () => {
    const { owner } = await scene();
    expect(
      await getProjectForUser(owner.id, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });
});

describe("milestones", () => {
  beforeEach(resetDb);

  it("admin 可建里程碑并列出", async () => {
    const { owner, team } = await scene();
    const p = await createProject(owner.id, team.id, { name: "甲计划" });
    const m = await createMilestone(owner.id, p.id, {
      title: "中期答辩",
      targetDate: "2026-11-15",
    });
    expect(m.status).toBe("open");
    const list = await listProjectMilestones(owner.id, p.id);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("中期答辩");
  });

  it("student 建里程碑被拒", async () => {
    const { owner, team, student } = await scene();
    const p = await createProject(owner.id, team.id, { name: "甲计划" });
    await expect(
      createMilestone(student.id, p.id, { title: "私设节点" }),
    ).rejects.toThrow("没有权限");
  });

  it("teacher 建里程碑被拒（仅 admin）", async () => {
    const { owner, team } = await scene();
    const teacher = await makeUser("teacher@example.com");
    await joinTeam(teacher.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, teacher.id, "teacher");
    const p = await createProject(owner.id, team.id, { name: "甲计划" });
    await expect(
      createMilestone(teacher.id, p.id, { title: "越权节点" }),
    ).rejects.toThrow("没有权限");
  });
});
