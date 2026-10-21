import { describe, it, expect } from "vitest";
import {
  buildContinuationText,
  continuationOriginalText,
  isContinuableTool,
  isContinuationText,
  summarizeDraft,
} from "@/lib/agent/continuation";

describe("summarizeDraft", () => {
  it("按工具给出可读摘要，标题过长时截断", () => {
    expect(summarizeDraft({ tool: "create_project", draft: { name: "赤壁演习" } })).toBe(
      "创建项目「赤壁演习」",
    );
    expect(
      summarizeDraft({ tool: "create_project", draft: { name: "长".repeat(60) } }),
    ).toBe(`创建项目「${"长".repeat(40)}…」`);
    expect(summarizeDraft({ tool: "create_milestone", draft: { title: "中期答辩" } })).toBe(
      "里程碑「中期答辩」",
    );
  });

  it("拆解任务列前 5 条，多出来的用「等」带过", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ title: `任务${i}` }));
    expect(summarizeDraft({ tool: "decompose_tasks", draft: { tasks } })).toBe(
      "拆解任务（任务0、任务1、任务2、任务3、任务4等）",
    );
    expect(summarizeDraft({ tool: "decompose_tasks", draft: { tasks: [] } })).toBe(
      "拆解任务（0 条）",
    );
  });

  it("批量变更 / 依赖调整 / 排期带数量与增删", () => {
    expect(
      summarizeDraft({ tool: "update_tasks", draft: { updates: [{}, {}] } }),
    ).toBe("批量变更（2 项）");
    expect(
      summarizeDraft({
        tool: "edit_task_links",
        draft: { predecessorTitle: "写开题报告", add: ["a"], remove: ["b", "c"] },
      }),
    ).toBe("依赖调整（写开题报告，+1/-2）");
    expect(
      summarizeDraft({ tool: "plan_sprint", draft: { taskIds: ["a", "b", "c"] } }),
    ).toBe("排期（3 个任务）");
    expect(
      summarizeDraft({ tool: "save_personal_context", draft: { entries: [{}] } }),
    ).toBe("个人上下文（1 条）");
  });

  it("子任务与附件摘要带标题/文件名，消息附件带目标任务", () => {
    expect(
      summarizeDraft({ tool: "create_subtask", draft: { title: "画原型图" } }),
    ).toBe("新增子任务「画原型图」");
    expect(
      summarizeDraft({ tool: "delete_subtask", draft: { title: "画原型图" } }),
    ).toBe("删除子任务「画原型图」");
    expect(
      summarizeDraft({ tool: "delete_attachment", draft: { filename: "开题报告.pdf" } }),
    ).toBe("删除附件「开题报告.pdf」");
    expect(
      summarizeDraft({
        tool: "attach_message_file_to_task",
        draft: { filename: "设计稿.png", taskTitle: "改首页" },
      }),
    ).toBe("消息附件「设计稿.png」→ 任务「改首页」");
  });

  it("发送 / 转发 / 建群摘要带对象与附件", () => {
    expect(
      summarizeDraft({
        tool: "send_message",
        draft: { targetName: "张三", filename: "设计稿.png" },
      }),
    ).toBe("发送消息给「张三」（附件 设计稿.png）");
    expect(
      summarizeDraft({ tool: "send_message", draft: { targetName: "讨论组" } }),
    ).toBe("发送消息给「讨论组」");
    expect(
      summarizeDraft({ tool: "forward_message", draft: { targetName: "李四" } }),
    ).toBe("转发消息给「李四」");
    expect(
      summarizeDraft({
        tool: "create_group_chat",
        draft: { name: "讨论组", memberCount: 3 },
      }),
    ).toBe("组建群聊「讨论组」（3 人）");
    expect(
      summarizeDraft({
        tool: "invite_to_group",
        draft: { groupName: "讨论组", usernames: ["张三", "李四"] },
      }),
    ).toBe("邀请「张三、李四」进群「讨论组」");
    expect(
      summarizeDraft({
        tool: "invite_to_group",
        draft: { groupName: "讨论组", usernames: ["甲", "乙", "丙", "丁"] },
      }),
    ).toBe("邀请「甲、乙、丙等」进群「讨论组」");
  });

  it("群邀请摘要带群名与接受/拒绝", () => {
    expect(
      summarizeDraft({
        tool: "respond_group_invite",
        draft: { groupName: "讨论组", accept: true },
      }),
    ).toBe("群邀请「讨论组」接受");
    expect(
      summarizeDraft({ tool: "respond_group_invite", draft: { accept: false } }),
    ).toBe("群邀请「未知群聊」拒绝");
  });

  it("资源占用与标签摘要带团队 / 资源名 / 标签名", () => {
    expect(
      summarizeDraft({
        tool: "create_resource_usage",
        draft: {
          teamName: "东吴实验室",
          resourceName: "GPU-01",
          startTime: "2026-11-01T14:00",
          endTime: "2026-11-01T16:00",
        },
      }),
    ).toBe("登记占用「GPU-01」（东吴实验室） 2026-11-01T14:00 → 2026-11-01T16:00");
    expect(
      summarizeDraft({
        tool: "create_resource_usage",
        draft: { resourceName: "GPU-01", startTime: "2026-11-01T14:00" },
      }),
    ).toBe("登记占用「GPU-01」 2026-11-01T14:00 起");
    expect(
      summarizeDraft({ tool: "end_resource_usage", draft: { resourceName: "GPU-01" } }),
    ).toBe("结束占用「GPU-01」");
    expect(
      summarizeDraft({
        tool: "create_label",
        draft: { name: "论文", teamName: "东吴实验室" },
      }),
    ).toBe("新建标签「论文」（东吴实验室）");
    expect(
      summarizeDraft({
        tool: "update_label",
        draft: { currentName: "论文", name: "小论文" },
      }),
    ).toBe("修改标签「论文」 → 「小论文」");
    expect(
      summarizeDraft({ tool: "update_label", draft: { currentName: "论文" } }),
    ).toBe("修改标签「论文」");
    expect(summarizeDraft({ tool: "delete_label", draft: { name: "论文" } })).toBe(
      "删除标签「论文」",
    );
    expect(
      summarizeDraft({
        tool: "edit_task_labels",
        draft: { taskTitle: "写开题报告", labelIds: ["a", "b"] },
      }),
    ).toBe("任务标签「写开题报告」（2 个）");
  });

  it("认不出的工具退回工具名，不抛错", () => {
    expect(summarizeDraft({ tool: "future_tool", draft: {} })).toBe("future_tool");
  });
});

describe("isContinuableTool", () => {
  it("只有会派生新 id / 新状态的项目写工具才值得续做", () => {
    for (const t of [
      "create_project",
      "decompose_tasks",
      "update_tasks",
      "edit_task_links",
      "plan_sprint",
      "create_milestone",
      "create_subtask",
      "create_group_chat",
      "create_resource_usage",
      "create_label",
    ]) {
      expect(isContinuableTool(t), t).toBe(true);
    }
    // 这些不派生「依赖新 id」的动作
    expect(isContinuableTool("save_personal_context")).toBe(false);
    expect(isContinuableTool("respond_group_invite")).toBe(false);
    expect(isContinuableTool("delete_subtask")).toBe(false);
    expect(isContinuableTool("delete_attachment")).toBe(false);
    expect(isContinuableTool("attach_message_file_to_task")).toBe(false);
    expect(isContinuableTool("send_message")).toBe(false);
    expect(isContinuableTool("forward_message")).toBe(false);
    expect(isContinuableTool("invite_to_group")).toBe(false);
    expect(isContinuableTool("end_resource_usage")).toBe(false);
    expect(isContinuableTool("update_label")).toBe(false);
    expect(isContinuableTool("delete_label")).toBe(false);
    expect(isContinuableTool("edit_task_labels")).toBe(false);
  });
});

describe("buildContinuationText", () => {
  it("自包含：原请求、已落库、未确认草案与三条续做要求", () => {
    const text = buildContinuationText({
      originalText: "建两个任务，再给第一个加后置",
      committed: [
        { tool: "decompose_tasks", draft: { tasks: [{ title: "甲" }, { title: "乙" }] } },
      ],
      remaining: [{ tool: "create_milestone", draft: { title: "中期答辩" } }],
    });

    expect(text).toContain("【继续上一轮请求】");
    expect(text).toContain("原请求：「建两个任务，再给第一个加后置」");
    expect(text).toContain("已落库：拆解任务（甲、乙）");
    expect(text).toContain("拆解任务（甲、乙）");
    expect(text).toContain("尚未确认的草案（不要重复生成，也不要改动它们）：里程碑「中期答辩」");
    expect(text).toContain("依赖已落库内容/新 id 的后续动作");
    expect(text).toContain("不要重复生成");
    expect(text).toContain("不要臆造 id");
  });

  it("原请求过长时截到 500 字", () => {
    const text = buildContinuationText({
      originalText: "长".repeat(800),
      committed: [],
      remaining: [],
    });
    expect(text).toContain(`「${"长".repeat(500)}…」`);
    expect(text).not.toContain("长".repeat(501));
  });

  it("没有已落库 / 未确认条目时写「无」，不出现空列表", () => {
    const text = buildContinuationText({ originalText: "", committed: [], remaining: [] });
    expect(text).toContain("原请求：「（未记录）」");
    expect(text).toContain("已落库：无");
    expect(text).toContain("不要改动它们）：无");
  });
});

describe("continue 提示词的识别", () => {
  const prompt = buildContinuationText({
    originalText: "建两个任务，再给第一个加后置",
    committed: [],
    remaining: [],
  });

  it("提示词以标记开头，普通提问不算", () => {
    expect(isContinuationText(prompt)).toBe(true);
    expect(isContinuationText("  \n" + prompt)).toBe(true);
    expect(isContinuationText("把这个拆成任务")).toBe(false);
    expect(isContinuationText("[继续上一轮请求]")).toBe(false);
  });

  it("续做提示词能取回最初的原请求；普通提问原样返回", () => {
    expect(continuationOriginalText(prompt)).toBe("建两个任务，再给第一个加后置");
    expect(continuationOriginalText("把这个拆成任务")).toBe("把这个拆成任务");
  });

  it("原请求含换行或「」时也取得回来", () => {
    const tricky = buildContinuationText({
      originalText: "第一行\n第二行「引用」还在",
      committed: [{ tool: "create_milestone", draft: { title: "中期答辩" } }],
      remaining: [],
    });
    expect(continuationOriginalText(tricky)).toBe("第一行 第二行「引用」还在");
  });

  it("缺原请求行时返回空串，交给调用方回落", () => {
    expect(continuationOriginalText("【继续上一轮请求】\n随便什么")).toBe("");
  });
});
