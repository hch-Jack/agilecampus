import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, updateTask } from "@/lib/task";
import { addTaskPlanSegment } from "@/lib/task-plan";
import { countPlannedTasksOnDay, getWelcomeStats } from "@/lib/welcome";
import { addDays, todayIn, weekdayOfDate } from "@/lib/time";
import { resetDb } from "./helpers";

describe("countPlannedTasksOnDay", () => {
  const plans = {
    a: [{ start: "2026-03-01", end: "2026-03-05" }],
    b: [
      { start: "2026-03-05", end: "2026-03-06" },
      { start: "2026-03-10", end: "2026-03-10" },
    ],
    c: [{ start: "2026-03-06", end: "2026-03-07" }],
  };

  it("闭区间两端都算，同一任务多段只计一次", () => {
    expect(countPlannedTasksOnDay(plans, "2026-03-05")).toBe(2); // a + b（b 当天只有一段，另一段另一天）
    expect(countPlannedTasksOnDay(plans, "2026-03-06")).toBe(2); // b + c
  });

  it("不在任何计划段内的日期不计", () => {
    expect(countPlannedTasksOnDay(plans, "2026-03-08")).toBe(0);
    expect(countPlannedTasksOnDay({}, "2026-03-08")).toBe(0);
  });
});

describe("getWelcomeStats", () => {
  beforeEach(resetDb);

  it("按工作台口径统计逾期/今日/本周/进行中，并计入今日计划", async () => {
    const user = await createUser({
      email: "welcome@example.com",
      password: "password123",
      name: "welcome",
    });
    const team = await createTeam(user.id, "东吴实验室");
    const project = await createProject(user.id, team.id, { name: "赤壁演习" });

    const today = todayIn("UTC");
    const weekEnd = addDays(today, (7 - weekdayOfDate(today)) % 7);

    // 逾期：昨天到期且未完成
    await createTask(user.id, project.id, {
      title: "逾期任务",
      assigneeId: user.id,
      dueDate: addDays(today, -1),
    });
    // 今天截止
    await createTask(user.id, project.id, {
      title: "今天截止",
      assigneeId: user.id,
      dueDate: today,
    });
    // 进行中 + 今天排期（日程表口径）
    const doing = await createTask(user.id, project.id, {
      title: "进行中",
      assigneeId: user.id,
    });
    await updateTask(user.id, doing.id, { status: "doing" });
    await addTaskPlanSegment(user.id, doing.id, project.id, today, today);
    // 本周截止：周日时本周没有「明天」，不加这条
    if (weekEnd > today) {
      await createTask(user.id, project.id, {
        title: "本周截止",
        assigneeId: user.id,
        dueDate: addDays(today, 1),
      });
    }

    const stats = await getWelcomeStats(user.id, "UTC");
    expect(stats.overdue).toBe(1);
    expect(stats.dueToday).toBe(1);
    expect(stats.dueThisWeek).toBe(weekEnd > today ? 1 : 0);
    expect(stats.doing).toBe(1);
    expect(stats.plannedToday).toBe(1);
  });
});
