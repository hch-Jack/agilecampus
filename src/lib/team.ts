import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, type DbTx } from "@/db";
import { milestones, projects, tasks, teamMembers, teams, users, type TeamRole } from "@/db/schema";
import { AppError, ForbiddenError, isUniqueViolation } from "./errors";

export async function createTeam(userId: string, name: string) {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({ name, inviteCode: nanoid(10) })
      .returning();
    await tx.insert(teamMembers).values({
      teamId: team.id,
      userId,
      role: "admin",
    });
    return team;
  });
}

// 注册时自填的身份 → 加入团队时的初始角色。
// 只有「导师」映射为 teacher，其余（未填 / 学生）一律 student；
// 建团者不受此影响，恒为 admin（见 createTeam）。
export async function initialTeamRole(userId: string): Promise<TeamRole> {
  const [user] = await db
    .select({ identity: users.identity })
    .from(users)
    .where(eq(users.id, userId));
  return user?.identity === "teacher" ? "teacher" : "student";
}

export async function joinTeam(userId: string, inviteCode: string) {
  const [team] = await db.select().from(teams).where(eq(teams.inviteCode, inviteCode));
  if (!team) throw new AppError("邀请码无效");

  const [existing] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)));
  if (existing) throw new AppError("已在该团队中");

  const role = await initialTeamRole(userId);
  try {
    const [member] = await db
      .insert(teamMembers)
      .values({ teamId: team.id, userId, role })
      .returning();
    return member;
  } catch (e) {
    // 查重与插入之间的并发窗口：另一请求已抢先加入，由 DB 唯一约束兜底
    if (isUniqueViolation(e)) throw new AppError("已在该团队中");
    throw e;
  }
}

// opts.tx 沿用 src/lib/task.ts 的惯例：传了就在调用方的事务里跑，不传就用连接池。
// 团队生命周期的几个写路径都要在同一个事务里读成员，故这里必须支持。
export async function getTeamMembership(
  userId: string,
  teamId: string,
  opts?: { tx?: DbTx },
) {
  const exec = opts?.tx ?? db;
  const [member] = await exec
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return member ?? null;
}

export async function requireTeamRole(
  userId: string,
  teamId: string,
  allowed: TeamRole[],
  opts?: { tx?: DbTx },
) {
  const member = await getTeamMembership(userId, teamId, opts);
  if (!member || !allowed.includes(member.role)) throw new ForbiddenError();
  return member;
}

// 无权限前置：调用方须已校验访问权（如 getProjectForUser / requireTeamRole）后再调用
export async function listTeamMembers(teamId: string) {
  return db
    .select({ id: users.id, name: users.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));
}

// ------------------------------------------------- 末位 admin 不变量（内部件）

/**
 * 锁住团队行，作为「这个团队的成员构成」这类跨行约束的串行化点。
 *
 * 锁的是 teams 行而不是 team_members 行：要守的约束是「本团队还有几名 admin」，
 * 锁成员行挡不住「两个 admin 同时把自己降级」或「两个 admin 同时退出」——
 * 那两件事锁的是不同的行，只有在同一个点上排队才看得见对方。
 *
 * 两条不能改的细节：
 *  · **必须是事务里的第一条语句**。晚于任何计数，那条计数读到的就是加锁前的快照，锁白拿。
 *  · Postgres 不允许对聚合（count(*)）加 FOR UPDATE，所以这里只选 teams.id 这个裸行，
 *    计数另起查询 —— 别图省事把两者并成一条。
 *
 * 团队不存在时这里查不到行、也不报错：调用方的成员查询会自然落空。
 */
async function lockTeam(tx: DbTx, teamId: string) {
  await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
}

async function countAdmins(tx: DbTx, teamId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")));
  return row?.n ?? 0;
}

/**
 * 「最后一名 admin 不可降级」不变量（docs/BACKLOG.md 的图九条目）。
 *
 * 调用方必须**已在事务内持有 lockTeam 的行锁**，否则并发下两个 admin 可以同时通过检查。
 * nextRole 为 "admin" 时数量不变，直接放行；提拔也从不受阻。
 */
async function assertKeepsAnAdmin(
  tx: DbTx,
  teamId: string,
  targetUserId: string,
  nextRole: TeamRole,
) {
  const target = await getTeamMembership(targetUserId, teamId, { tx });
  if (!target) throw new AppError("该成员不在团队中");
  if (target.role !== "admin" || nextRole === "admin") return;
  if ((await countAdmins(tx, teamId)) <= 1) {
    throw new AppError("团队至少需要保留一名管理员。请先把其他成员设为管理员，再改这一位。");
  }
}

// --------------------------------------------------------------- 团队生命周期

/**
 * 改成员角色。
 *
 * **这不是产品能力，只是测试搭台的梯子 —— 别当后门删掉，也别从服务端代码里调用。**
 *
 * 用户的规矩是「身份只由注册时选定的身份决定」，故网页上的改身份入口已撤掉
 * （members/actions.ts 不再有 updateRoleAction），产品代码里**零调用方**。
 * 之所以留着它：tests/ 下十余处要靠它造出一个 teacher 或第二名 admin，
 * 而「两名 admin 互相降级」那条锁回归防线（tests/team.test.ts）在网页入口撤掉后
 * 更没有别的写法 —— 删掉这个函数等于删掉那一片覆盖。
 */
export async function updateMemberRole(
  actorId: string,
  teamId: string,
  targetUserId: string,
  role: TeamRole,
) {
  await requireTeamRole(actorId, teamId, ["admin"]);
  return db.transaction(async (tx) => {
    await lockTeam(tx, teamId);
    // 目标是否存在由这里一并校验（同一个事务、同一把锁），下面不再重复判断
    await assertKeepsAnAdmin(tx, teamId, targetUserId, role);
    const [updated] = await tx
      .update(teamMembers)
      .set({ role })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)))
      .returning();
    return updated;
  });
}

/**
 * 解散团队：**硬删除，不可逆**。
 *
 * 所有外键都挂在 teams 上且 onDelete cascade（级联图见 src/db/schema.ts），
 * 所以这一条 DELETE 会连带清空 projects → milestones / tasks / task_dependencies /
 * task_labels / conversations → messages，以及 resource_usages、labels、team_members。
 * 级联在同一语句内完成，不必再包事务，也不会留下孤儿行。
 */
export async function dissolveTeam(actorId: string, teamId: string) {
  await requireTeamRole(actorId, teamId, ["admin"]);
  await db.delete(teams).where(eq(teams.id, teamId));
}

/**
 * 把成员移出团队。
 *
 * 两条边界（用户定的）：
 *  · 管理员**不可被移除** —— 管理员只能自己用「退出团队」走
 *  · 不能移除自己 —— 同上
 *
 * 因此本函数**不可能**制造出「零 admin」的团队：操作者自己必然是 admin 且留在团里。
 * 也就不需要 lockTeam 那套锁。
 */
export async function removeMember(actorId: string, teamId: string, targetUserId: string) {
  await requireTeamRole(actorId, teamId, ["admin"]);
  if (actorId === targetUserId) {
    throw new AppError("不能移除自己。如需离开团队，请用「退出团队」。");
  }

  // 「管理员不可被移除」交给 DB 在删除那一刻判定（谓词里的 ne），
  // 于是「先查再删」之间的竞态窗口根本不存在 —— 读到和删掉的是同一件事。
  const [removed] = await db
    .delete(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, targetUserId),
        ne(teamMembers.role, "admin"),
      ),
    )
    .returning();
  if (removed) return removed;

  // 一行都没删掉，分开报错才给得出可操作的提示
  const target = await getTeamMembership(targetUserId, teamId);
  if (!target) throw new AppError("该成员不在团队中");
  // 不再说「先改其角色再移除」—— 改角色的入口已撤掉（身份只由注册决定），
  // 那是一句把人往死路上指的话。管理员要离开只有一条路：自己「退出团队」。
  throw new AppError("不能移除管理员。管理员要离开，只能自己退出团队并指定接任者。");
}

/**
 * 退出团队。三种收场：
 *  · 团里只剩自己 → 解散，但**要页面明确带 dissolveIfSole 才做**（见下方注释）
 *  · 自己是唯一 admin 且还有别人 → 必须指定 successorUserId 接任，否则拒绝
 *  · 其余 → 直接退出
 *
 * 全程在一个事务里、开头就 lockTeam：继任者升 admin 与自己的成员行删除必须要么都成、
 * 要么都不成，否则会留下「继任者没升上去、自己已经走了」的空心团队。
 *
 * **这把锁在这里比在 updateMemberRole 里更要紧**：两名 admin 同时点退出时，
 * 没有锁则两个事务都读到「还有 2 名 admin」，双双走「直接退出」那条路，
 * 事后团队剩 0 名成员、0 名管理员，但 teams 行还在——一个谁都看不见、也管不了的空壳，
 * 名下的项目与任务成了孤儿。有了锁，后到的事务拿锁后重新计数会看到只剩 1 名 admin，
 * 于是被拦下来要继任者（或落进「只剩自己」那一支）。
 */
export async function leaveTeam(
  userId: string,
  teamId: string,
  opts?: { successorUserId?: string; dissolveIfSole?: boolean },
): Promise<{ dissolved: boolean }> {
  const { successorUserId, dissolveIfSole } = opts ?? {};
  return db.transaction(async (tx) => {
    await lockTeam(tx, teamId);

    const members = await tx
      .select({ userId: teamMembers.userId, role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));
    const me = members.find((m) => m.userId === userId);
    if (!me) throw new ForbiddenError();

    if (members.length === 1) {
      // 「只剩自己 → 直接解散」是用户定的规矩，但**必须由页面明确要求**才执行。
      // 页面渲染到这一秒之间可能有人刚好退出，把「还有别人」变成「只剩你一人」，
      // 而用户当时看到的确认框只写了「退出后可凭邀请码重新加入」——只字未提会删掉整个团队。
      // 没带这个意思时就拒绝，请用户刷新、看到真正的解散确认（带数量）再动手。
      // 这是一个确认令牌，不是安全边界：伪造它只会让用户自己确认过的那件事得以执行。
      if (!dissolveIfSole) {
        throw new AppError(
          "团队现在只剩你一人。退出将解散团队（连同其全部项目与任务），请刷新页面后再确认。",
        );
      }
      await tx.delete(teams).where(eq(teams.id, teamId));
      return { dissolved: true };
    }

    // 交棒。这一步只认管理员：否则任何成员都能靠退出把一个同伙直接抬成管理员。
    if (successorUserId) {
      if (me.role !== "admin") throw new AppError("只有管理员可以指定接任者。");
      if (successorUserId === userId) throw new AppError("接任者不能是自己。");
      const successor = members.find((m) => m.userId === successorUserId);
      if (!successor) throw new AppError("接任者不是本团队成员。");
      if (successor.role !== "admin") {
        await tx
          .update(teamMembers)
          .set({ role: "admin" })
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, successorUserId)));
      }
    }

    // 唯一 admin 想走又没交棒 → 拦住。接任者此刻已是 admin，故要把 TA 排除在计数之外。
    const adminsLeft = members.filter(
      (m) => m.role === "admin" && m.userId !== userId && m.userId !== successorUserId,
    ).length;
    if (me.role === "admin" && adminsLeft === 0 && !successorUserId) {
      throw new AppError("你是团队唯一的管理员，退出前请先指定一名成员接任管理员。");
    }

    await tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return { dissolved: false };
  });
}

// ----------------------------------------------------------------- 计数与列表

export type TeamContentCounts = {
  projects: number;
  milestones: number;
  tasks: number;
  members: number;
};

const NO_CONTENT: TeamContentCounts = { projects: 0, milestones: 0, tasks: 0, members: 0 };

/**
 * 若干团队各自「解散会带走多少东西」。
 *
 * 4 条分组聚合查询覆盖**全部**团队（不是每团 4 条），用 Map 收口 ——
 * 与 labels/page.tsx 算 usage 的写法同一路子。入参为空直接短路，不发查询。
 */
async function countContentForTeams(teamIds: string[]): Promise<Map<string, TeamContentCounts>> {
  const counts = new Map<string, TeamContentCounts>(
    teamIds.map((id) => [id, { ...NO_CONTENT }]),
  );
  if (teamIds.length === 0) return counts;

  const [projectRows, milestoneRows, taskRows, memberRows] = await Promise.all([
    db
      .select({ teamId: projects.teamId, n: sql<number>`count(*)::int` })
      .from(projects)
      .where(inArray(projects.teamId, teamIds))
      .groupBy(projects.teamId),
    // 里程碑与任务都挂在项目下，经 projects 回到 teamId。
    // 用 leftJoin + count(列) 而非 innerJoin：没有里程碑的项目也要出一行 0。
    db
      .select({ teamId: projects.teamId, n: sql<number>`count(${milestones.id})::int` })
      .from(projects)
      .leftJoin(milestones, eq(milestones.projectId, projects.id))
      .where(inArray(projects.teamId, teamIds))
      .groupBy(projects.teamId),
    db
      .select({ teamId: projects.teamId, n: sql<number>`count(${tasks.id})::int` })
      .from(projects)
      .leftJoin(tasks, eq(tasks.projectId, projects.id))
      .where(inArray(projects.teamId, teamIds))
      .groupBy(projects.teamId),
    db
      .select({ teamId: teamMembers.teamId, n: sql<number>`count(*)::int` })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, teamIds))
      .groupBy(teamMembers.teamId),
  ]);

  const put = (teamId: string, key: keyof TeamContentCounts, n: number) => {
    const cur = counts.get(teamId);
    if (cur) cur[key] = n;
  };
  for (const r of projectRows) put(r.teamId, "projects", r.n);
  for (const r of milestoneRows) put(r.teamId, "milestones", r.n);
  for (const r of taskRows) put(r.teamId, "tasks", r.n);
  for (const r of memberRows) put(r.teamId, "members", r.n);
  return counts;
}

/** 单个团队的内容计数：成员页「只剩我一个人 → 退出即解散」的确认框要用同一份口径。 */
export async function teamContentCounts(teamId: string): Promise<TeamContentCounts> {
  const counts = await countContentForTeams([teamId]);
  return counts.get(teamId) ?? { ...NO_CONTENT };
}

/** 我的团队列表（含各团队的内容计数），供 /teams 一屏渲染。 */
export async function listMyTeams(userId: string) {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      inviteCode: teams.inviteCode,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId));

  const counts = await countContentForTeams(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, counts: counts.get(r.id) ?? { ...NO_CONTENT } }));
}
