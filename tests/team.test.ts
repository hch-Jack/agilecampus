import { describe, it, expect, beforeEach } from "vitest";
import type { PgTable } from "drizzle-orm/pg-core";
import { createUser } from "@/lib/user";
import {
  createTeam,
  dissolveTeam,
  getTeamMembership,
  joinTeam,
  leaveTeam,
  listMyTeams,
  listTeamMembers,
  removeMember,
  requireTeamRole,
  teamContentCounts,
  updateMemberRole,
} from "@/lib/team";
import { AppError } from "@/lib/errors";
import { resetDb } from "./helpers";
import { db } from "@/db";
import {
  conversations,
  labels,
  messages,
  milestones,
  projects,
  resourceUsages,
  taskLabels,
  tasks,
  teamMembers,
  teams,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

// 全表行数。级联测试里逐表对着 0 断言，比断言「某一条查不到了」扎实得多
async function countOf(table: PgTable): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row.n;
}

async function adminCount(teamId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")));
  return row.n;
}

// 一个团队名下的全套数据，用于证明「解散」的级联真的走通整棵子树
async function seedTeamContent(teamId: string, userId: string) {
  const [project] = await db.insert(projects).values({ teamId, name: "实验一" }).returning();
  const [milestone] = await db
    .insert(milestones)
    .values({ projectId: project.id, title: "开题" })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({ projectId: project.id, title: "写代码", milestoneId: milestone.id })
    .returning();
  const [label] = await db.insert(labels).values({ teamId, name: "论文" }).returning();
  await db.insert(taskLabels).values({ taskId: task.id, labelId: label.id });
  const [conversation] = await db
    .insert(conversations)
    .values({ projectId: project.id, createdById: userId })
    .returning();
  await db
    .insert(messages)
    .values({ conversationId: conversation.id, role: "user", content: "嗨" });
  await db
    .insert(resourceUsages)
    .values({ teamId, userId, resourceName: "A100", startTime: new Date() });
  return project;
}

describe("createTeam", () => {
  beforeEach(resetDb);

  it("创建团队，创建者成为 admin，且生成邀请码", async () => {
    const u = await makeUser("owner@example.com");
    const team = await createTeam(u.id, "东吴实验室");
    expect(team.name).toBe("东吴实验室");
    expect(team.inviteCode).toHaveLength(10);

    const [m] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, u.id)));
    expect(m.role).toBe("admin");
  });
});

describe("joinTeam", () => {
  beforeEach(resetDb);

  it("凭邀请码加入，默认角色 student", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const joiner = await makeUser("joiner@example.com");

    const joined = await joinTeam(joiner.id, team.inviteCode);
    expect(joined.teamId).toBe(team.id);

    const [m] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, joiner.id)));
    expect(m.role).toBe("student");
  });

  it("邀请码无效时抛出可展示错误", async () => {
    const u = await makeUser("a@example.com");
    await expect(joinTeam(u.id, "no-such-code")).rejects.toThrow("邀请码无效");
  });

  it("重复加入抛出可展示错误", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    await expect(joinTeam(owner.id, team.inviteCode)).rejects.toThrow("已在该团队中");
  });

  it("绕过查重的唯一键冲突（23505）被转译为可展示的 AppError", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const joiner = await makeUser("joiner@example.com");

    let releaseTx!: () => void;
    const hold = new Promise<void>((r) => (releaseTx = r));
    let markInserted!: () => void;
    const inserted = new Promise<void>((r) => (markInserted = r));

    // 事务先插入同一 (team_id, user_id) 但不提交：joinTeam 的查重（读已提交）看不到该行，
    // 其 insert 将阻塞在唯一索引锁上；事务提交后必现 23505，
    // 从而确定性地覆盖「查重通过但唯一约束拦截」的竞态路径。
    const tx = db.transaction(async (trx) => {
      await trx.insert(teamMembers).values({ teamId: team.id, userId: joiner.id, role: "student" });
      markInserted();
      await hold;
    });

    await inserted;
    const pending = joinTeam(joiner.id, team.inviteCode);
    pending.catch(() => {}); // 预挂 handler，消除拒绝早于断言挂接的瞬时 unhandled rejection
    await new Promise((r) => setTimeout(r, 300)); // 让 joinTeam 完成查重并阻塞于 insert
    releaseTx();
    await tx;

    await expect(pending).rejects.toBeInstanceOf(AppError);
    await expect(pending).rejects.toThrow("已在该团队中");
  });
});

describe("joinTeam 按注册身份定初始角色", () => {
  beforeEach(resetDb);

  async function makeUserWithIdentity(email: string, identity: "teacher" | "student") {
    return createUser({ email, password: "password123", name: email.split("@")[0], identity });
  }

  it("导师身份加入团队即 teacher", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const t = await makeUserWithIdentity("t@example.com", "teacher");

    const joined = await joinTeam(t.id, team.inviteCode);
    expect(joined.role).toBe("teacher");
  });

  it("学生身份加入团队为 student", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const s = await makeUserWithIdentity("s@example.com", "student");

    const joined = await joinTeam(s.id, team.inviteCode);
    expect(joined.role).toBe("student");
  });

  it("未填身份的存量用户按 student 处理", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const legacy = await makeUser("legacy@example.com");

    const joined = await joinTeam(legacy.id, team.inviteCode);
    expect(joined.role).toBe("student");
  });

  it("导师身份自建团队仍为 admin，不因身份降级", async () => {
    const t = await makeUserWithIdentity("owner-teacher@example.com", "teacher");
    const team = await createTeam(t.id, "东吴实验室");

    const [m] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, t.id)));
    expect(m.role).toBe("admin");
  });
});

describe("getTeamMembership", () => {
  beforeEach(resetDb);

  it("成员返回记录（含 role）", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const m = await getTeamMembership(owner.id, team.id);
    expect(m).not.toBeNull();
    expect(m!.role).toBe("admin");
  });

  it("非成员返回 null", async () => {
    const owner = await makeUser("owner@example.com");
    const outsider = await makeUser("outsider@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const m = await getTeamMembership(outsider.id, team.id);
    expect(m).toBeNull();
  });
});

describe("requireTeamRole", () => {
  beforeEach(resetDb);

  it("角色在允许列表内则返回成员记录", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const m = await requireTeamRole(owner.id, team.id, ["admin"]);
    expect(m.role).toBe("admin");
  });

  it("非成员抛 ForbiddenError", async () => {
    const owner = await makeUser("owner@example.com");
    const outsider = await makeUser("outsider@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    await expect(requireTeamRole(outsider.id, team.id, ["admin", "teacher", "student"]))
      .rejects.toThrow("没有权限");
  });

  it("角色不足抛 ForbiddenError", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("student@example.com");
    await joinTeam(student.id, team.inviteCode);
    await expect(requireTeamRole(student.id, team.id, ["admin"]))
      .rejects.toThrow("没有权限");
  });

  it("teacher 矩阵：允许列表含 teacher 则通过，仅 admin 则拒", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const teacher = await makeUser("teacher@example.com");
    await joinTeam(teacher.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, teacher.id, "teacher");

    const m = await requireTeamRole(teacher.id, team.id, ["admin", "teacher"]);
    expect(m.role).toBe("teacher");
    await expect(requireTeamRole(teacher.id, team.id, ["admin"]))
      .rejects.toThrow("没有权限");
  });
});

describe("listTeamMembers", () => {
  beforeEach(resetDb);

  it("返回团队全员（含 role）", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const teacher = await makeUser("teacher@example.com");
    await joinTeam(teacher.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, teacher.id, "teacher");

    const list = await listTeamMembers(team.id);
    expect(list).toHaveLength(2);
    expect(list.find((m) => m.id === owner.id)?.role).toBe("admin");
    const t = list.find((m) => m.id === teacher.id);
    expect(t?.role).toBe("teacher");
    expect(t?.name).toBe("teacher");
  });

  it("不含他团队成员", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const other = await makeUser("other@example.com");
    await createTeam(other.id, "曹魏参谋部");

    const list = await listTeamMembers(team.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(owner.id);
  });
});

describe("updateMemberRole", () => {
  beforeEach(resetDb);

  it("admin 可将成员改为 teacher", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const member = await makeUser("t@example.com");
    await joinTeam(member.id, team.inviteCode);

    const updated = await updateMemberRole(owner.id, team.id, member.id, "teacher");
    expect(updated.role).toBe("teacher");
  });

  it("student 无权改角色", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const s1 = await makeUser("s1@example.com");
    const s2 = await makeUser("s2@example.com");
    await joinTeam(s1.id, team.inviteCode);
    await joinTeam(s2.id, team.inviteCode);

    await expect(updateMemberRole(s1.id, team.id, s2.id, "teacher"))
      .rejects.toThrow("没有权限");
  });

  it("目标用户不在团队中抛可展示错误", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const outsider = await makeUser("outsider@example.com");

    await expect(updateMemberRole(owner.id, team.id, outsider.id, "teacher"))
      .rejects.toThrow("该成员不在团队中");
  });
});

describe("updateMemberRole 末位 admin 不变量", () => {
  beforeEach(resetDb);

  it("唯一 admin 不能把自己降级", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");

    await expect(updateMemberRole(owner.id, team.id, owner.id, "student"))
      .rejects.toThrow("至少需要保留一名管理员");
    // 被拒之后角色必须原地不动
    const m = await getTeamMembership(owner.id, team.id);
    expect(m!.role).toBe("admin");
  });

  it("唯一 admin 把自己改成 admin 不算降级，放行", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");

    const updated = await updateMemberRole(owner.id, team.id, owner.id, "admin");
    expect(updated.role).toBe("admin");
  });

  it("唯一 admin 可以把学生提升为 admin（守卫只拦降级，不拦提拔）", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);

    const updated = await updateMemberRole(owner.id, team.id, student.id, "admin");
    expect(updated.role).toBe("admin");
  });

  it("两名 admin 时可降其一，但降完剩下的那位就不能再降了", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const second = await makeUser("second@example.com");
    await joinTeam(second.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, second.id, "admin");

    // 还有两名 admin，降一个是安全的
    await expect(updateMemberRole(owner.id, team.id, second.id, "student")).resolves.toBeTruthy();
    // 现在 owner 成了唯一的 admin，谁也降不动他了
    await expect(updateMemberRole(second.id, team.id, owner.id, "student"))
      .rejects.toThrow("没有权限");
    expect((await getTeamMembership(owner.id, team.id))!.role).toBe("admin");
  });
});

describe("dissolveTeam", () => {
  beforeEach(resetDb);

  it("解散后团队连同名下全部数据一并消失（逐表实证级联）", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const member = await makeUser("m@example.com");
    await joinTeam(member.id, team.inviteCode);
    await seedTeamContent(team.id, owner.id);

    // 先确认种下去的数据真在（否则下面全是假绿）
    expect(await countOf(projects)).toBe(1);
    expect(await countOf(messages)).toBe(1);

    await dissolveTeam(owner.id, team.id);

    expect(await countOf(teams)).toBe(0);
    expect(await countOf(teamMembers)).toBe(0);
    expect(await countOf(projects)).toBe(0);
    expect(await countOf(milestones)).toBe(0);
    expect(await countOf(tasks)).toBe(0);
    expect(await countOf(labels)).toBe(0);
    expect(await countOf(taskLabels)).toBe(0);
    expect(await countOf(conversations)).toBe(0);
    expect(await countOf(messages)).toBe(0);
    expect(await countOf(resourceUsages)).toBe(0);
  });

  it("只清掉本团队，别的团队不受牵连", async () => {
    const owner = await makeUser("owner@example.com");
    const doomed = await createTeam(owner.id, "东吴实验室");
    const kept = await createTeam(owner.id, "曹魏参谋部");
    await seedTeamContent(doomed.id, owner.id);
    await seedTeamContent(kept.id, owner.id);

    await dissolveTeam(owner.id, doomed.id);

    expect(await countOf(teams)).toBe(1);
    expect(await countOf(projects)).toBe(1);
    const [survivor] = await db.select().from(projects);
    expect(survivor.teamId).toBe(kept.id);
  });

  it("teacher 无权解散", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const teacher = await makeUser("t@example.com");
    await joinTeam(teacher.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, teacher.id, "teacher");

    await expect(dissolveTeam(teacher.id, team.id)).rejects.toThrow("没有权限");
    expect(await countOf(teams)).toBe(1);
  });

  it("非成员无权解散", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const outsider = await makeUser("outsider@example.com");

    await expect(dissolveTeam(outsider.id, team.id)).rejects.toThrow("没有权限");
    expect(await countOf(teams)).toBe(1);
  });
});

describe("removeMember", () => {
  beforeEach(resetDb);

  it("admin 可移除学生", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);

    await removeMember(owner.id, team.id, student.id);
    expect(await getTeamMembership(student.id, team.id)).toBeNull();
    expect(await countOf(teamMembers)).toBe(1);
  });

  it("admin 可移除导师", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const teacher = await makeUser("t@example.com");
    await joinTeam(teacher.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, teacher.id, "teacher");

    await removeMember(owner.id, team.id, teacher.id);
    expect(await getTeamMembership(teacher.id, team.id)).toBeNull();
  });

  it("管理员不可被移除，提示先改角色", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const second = await makeUser("second@example.com");
    await joinTeam(second.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, second.id, "admin");

    await expect(removeMember(owner.id, team.id, second.id)).rejects.toThrow("不能移除管理员");
    expect(await getTeamMembership(second.id, team.id)).not.toBeNull();
  });

  it("不能移除自己", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");

    await expect(removeMember(owner.id, team.id, owner.id)).rejects.toThrow("不能移除自己");
    expect(await getTeamMembership(owner.id, team.id)).not.toBeNull();
  });

  it("student 无权移除他人", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const s1 = await makeUser("s1@example.com");
    const s2 = await makeUser("s2@example.com");
    await joinTeam(s1.id, team.inviteCode);
    await joinTeam(s2.id, team.inviteCode);

    await expect(removeMember(s1.id, team.id, s2.id)).rejects.toThrow("没有权限");
    expect(await countOf(teamMembers)).toBe(3);
  });

  it("目标不在团队中抛可展示错误", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const outsider = await makeUser("outsider@example.com");

    await expect(removeMember(owner.id, team.id, outsider.id)).rejects.toThrow("该成员不在团队中");
  });
});

describe("leaveTeam", () => {
  beforeEach(resetDb);

  it("团里只剩自己时退出即解散，连同项目一并清掉", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    await seedTeamContent(team.id, owner.id);

    const result = await leaveTeam(owner.id, team.id, { dissolveIfSole: true });
    expect(result).toEqual({ dissolved: true });
    expect(await countOf(teams)).toBe(0);
    expect(await countOf(projects)).toBe(0);
  });

  it("只剩自己但页面没要求解散时拒绝，绝不顺手删掉整个团队", async () => {
    // 场景：页面渲染时团里还有别人（确认框说的是「可凭邀请码重新加入」），
    // 提交前那人退出了。若此处照解散办，用户就在一个没提过「解散」的确认框上丢了整个团队。
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    await seedTeamContent(team.id, owner.id);

    await expect(leaveTeam(owner.id, team.id)).rejects.toThrow("只剩你一人");
    expect(await countOf(teams)).toBe(1);
    expect(await countOf(projects)).toBe(1);
    expect(await getTeamMembership(owner.id, team.id)).not.toBeNull();
  });

  it("唯一 admin 未指定继任者则被拒，且什么都没变", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);

    await expect(leaveTeam(owner.id, team.id)).rejects.toThrow("唯一的管理员");
    // 事务回滚：成员行与角色都得原地不动
    expect(await countOf(teamMembers)).toBe(2);
    expect((await getTeamMembership(owner.id, team.id))!.role).toBe("admin");
    expect((await getTeamMembership(student.id, team.id))!.role).toBe("student");
    expect(await countOf(teams)).toBe(1);
  });

  it("唯一 admin 指定继任者后退出，继任者成为管理员", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);

    const result = await leaveTeam(owner.id, team.id, { successorUserId: student.id });
    expect(result).toEqual({ dissolved: false });
    expect(await getTeamMembership(owner.id, team.id)).toBeNull();
    expect((await getTeamMembership(student.id, team.id))!.role).toBe("admin");
    expect(await adminCount(team.id)).toBe(1);
  });

  it("接任者不能是自己", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);

    await expect(leaveTeam(owner.id, team.id, { successorUserId: owner.id }))
      .rejects.toThrow("接任者不能是自己");
    expect(await countOf(teamMembers)).toBe(2);
  });

  it("接任者不是本团队成员则被拒", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);
    const outsider = await makeUser("outsider@example.com");

    await expect(leaveTeam(owner.id, team.id, { successorUserId: outsider.id }))
      .rejects.toThrow("接任者不是本团队成员");
    expect(await countOf(teamMembers)).toBe(2);
  });

  it("非管理员不能靠退出把同伙抬成管理员", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const s1 = await makeUser("s1@example.com");
    const s2 = await makeUser("s2@example.com");
    await joinTeam(s1.id, team.inviteCode);
    await joinTeam(s2.id, team.inviteCode);

    await expect(leaveTeam(s1.id, team.id, { successorUserId: s2.id }))
      .rejects.toThrow("只有管理员可以指定接任者");
    expect((await getTeamMembership(s2.id, team.id))!.role).toBe("student");
  });

  it("还有别的 admin 时直接退出，剩余 admin 不受影响", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const second = await makeUser("second@example.com");
    await joinTeam(second.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, second.id, "admin");

    await leaveTeam(owner.id, team.id);
    expect(await getTeamMembership(owner.id, team.id)).toBeNull();
    expect(await adminCount(team.id)).toBe(1);
  });

  it("学生退出无需任何条件", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);

    const result = await leaveTeam(student.id, team.id);
    expect(result).toEqual({ dissolved: false });
    expect(await getTeamMembership(student.id, team.id)).toBeNull();
    expect((await getTeamMembership(owner.id, team.id))!.role).toBe("admin");
  });

  it("非成员退出抛 ForbiddenError", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const outsider = await makeUser("outsider@example.com");

    await expect(leaveTeam(outsider.id, team.id)).rejects.toThrow("没有权限");
  });
});

describe("并发下的末位 admin 不变量", () => {
  beforeEach(resetDb);

  // 这两条用例是 lockTeam 那把行锁的回归防线。实测（把 lockTeam 注释掉跑）：
  //  · 「互相降级」这条稳定失败——两个事务都会读到「还有两名 admin」，双双得手，跑不掉；
  //  · 「同时退出」这条 8 次里失败 7 次——竞态测试没法保证两个事务一定交叠，
  //    偶尔会自然串行成没事的样子。所以**确定性**的那道防线是上面那条。

  it("两名 admin 同时退出，不会留下没人也没管理员的空壳团队", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    const team = await createTeam(a.id, "东吴实验室");
    await joinTeam(b.id, team.inviteCode);
    await updateMemberRole(a.id, team.id, b.id, "admin");
    await seedTeamContent(team.id, a.id);

    await Promise.allSettled([leaveTeam(a.id, team.id), leaveTeam(b.id, team.id)]);

    // 缺了 lockTeam 的实测结果（8 次里 7 次）：两人都走了，teams 行还在，
    // 成员 0、管理员 0 —— 一个谁都看不见也管不了的空壳，名下的项目与任务沦为孤儿。
    // 有锁时后到的那位拿锁后重新计数，看到自己已是唯一 admin，于是被拦下。
    expect(await countOf(teams)).toBe(1);
    expect(await countOf(teamMembers)).toBe(1);
    expect(await adminCount(team.id)).toBe(1);
    expect(await countOf(projects)).toBe(1);
  });

  it("两名 admin 同时把对方降级，只有一个能得手", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    const team = await createTeam(a.id, "东吴实验室");
    await joinTeam(b.id, team.inviteCode);
    await updateMemberRole(a.id, team.id, b.id, "admin");

    const results = await Promise.allSettled([
      updateMemberRole(a.id, team.id, b.id, "student"),
      updateMemberRole(b.id, team.id, a.id, "student"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    // 可能是「末位管理员不可降级」的 AppError，也可能是对方先把自己权限收走后抛的 ForbiddenError
    expect(rejected.reason).toBeInstanceOf(AppError);
    expect(await adminCount(team.id)).toBe(1);
  });
});

describe("listMyTeams / teamContentCounts", () => {
  beforeEach(resetDb);

  it("列出我的团队及其内容计数", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("s@example.com");
    await joinTeam(student.id, team.inviteCode);
    await seedTeamContent(team.id, owner.id);

    const [row] = await listMyTeams(owner.id);
    expect(row.id).toBe(team.id);
    expect(row.role).toBe("admin");
    expect(row.counts).toEqual({ projects: 1, milestones: 1, tasks: 1, members: 2 });
  });

  it("不含他团队，且没项目的团队计数全是 0", async () => {
    const owner = await makeUser("owner@example.com");
    const empty = await createTeam(owner.id, "东吴实验室");
    const other = await makeUser("other@example.com");
    const theirs = await createTeam(other.id, "曹魏参谋部");
    await seedTeamContent(theirs.id, other.id);

    const rows = await listMyTeams(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(empty.id);
    expect(rows[0].counts).toEqual({ projects: 0, milestones: 0, tasks: 0, members: 1 });
  });

  it("一个团队都没有时返回空数组（空 inArray 不得下发到 SQL）", async () => {
    const loner = await makeUser("loner@example.com");
    await expect(listMyTeams(loner.id)).resolves.toEqual([]);
  });

  it("teamContentCounts 与列表口径一致", async () => {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    await seedTeamContent(team.id, owner.id);

    await expect(teamContentCounts(team.id)).resolves.toEqual({
      projects: 1,
      milestones: 1,
      tasks: 1,
      members: 1,
    });
  });
});
