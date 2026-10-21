/**
 * 草案摘要与「落库后继续」文案。
 *
 * 这个模块是**纯函数**：编排器（服务端）与草案卡（客户端）都要引它，
 * 故不得 import `@/db`、`./tools` 或任何带副作用的模块。
 */

export const DRAFT_TOOL_LABELS: Record<string, string> = {
  create_project: "创建项目",
  decompose_tasks: "拆解任务",
  update_tasks: "批量变更",
  edit_task_links: "依赖调整",
  plan_sprint: "排期",
  create_milestone: "里程碑",
  create_subtask: "新增子任务",
  delete_subtask: "删除子任务",
  delete_attachment: "删除附件",
  save_personal_context: "个人上下文",
  respond_group_invite: "群邀请处理",
  attach_message_file_to_task: "消息附件",
  send_message: "发送消息",
  forward_message: "转发消息",
  create_group_chat: "组建群聊",
  invite_to_group: "邀请进群",
  create_resource_usage: "登记资源占用",
  end_resource_usage: "结束资源占用",
  create_label: "新建标签",
  update_label: "修改标签",
  delete_label: "删除标签",
  edit_task_labels: "任务标签",
};

/**
 * 落库后值得再问一轮的工具：它们会产生新 id / 新状态，
 * 用户原本一句话里的后续动作可能正等着这些 id。
 * 个人上下文与群邀请不会派生出「依赖新 id」的动作，故不在此列。
 */
const CONTINUABLE_TOOLS = new Set([
  "create_project",
  "decompose_tasks",
  "update_tasks",
  "edit_task_links",
  "plan_sprint",
  "create_milestone",
  // 新建子任务也是新 id：用户可能还想给它加后置/附件
  "create_subtask",
  // 新建群聊会产生 groupId：用户可能紧接着想往这个群发消息
  "create_group_chat",
  // 登记占用会产生 usageId：用户可能紧接着想结束它；新建标签会产生 labelId，
  // 用户可能想立刻把它贴到某个任务上
  "create_resource_usage",
  "create_label",
]);

export function isContinuableTool(tool: string): boolean {
  return CONTINUABLE_TOOLS.has(tool);
}

export type DraftLike = { tool: string; draft: unknown };

const TITLE_LIMIT = 40;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 一张草案的一行中文摘要，用于兜底正文与「继续」提示词 */
export function summarizeDraft(d: DraftLike): string {
  const body = asRecord(d.draft);
  switch (d.tool) {
    case "create_project": {
      const name = text(body.name);
      return name ? `创建项目「${clip(name, TITLE_LIMIT)}」` : "创建项目";
    }
    case "create_milestone": {
      const title = text(body.title);
      return title ? `里程碑「${clip(title, TITLE_LIMIT)}」` : "里程碑";
    }
    case "decompose_tasks": {
      const tasks = list(body.tasks);
      const titles = tasks
        .map((t) => text(asRecord(t).title))
        .filter((t): t is string => t !== null)
        .slice(0, 5)
        .map((t) => clip(t, TITLE_LIMIT));
      const more = tasks.length > titles.length ? "等" : "";
      return titles.length > 0
        ? `拆解任务（${titles.join("、")}${more}）`
        : `拆解任务（${tasks.length} 条）`;
    }
    case "update_tasks":
      return `批量变更（${list(body.updates).length} 项）`;
    case "edit_task_links": {
      const title = text(body.predecessorTitle);
      const added = list(body.add).length;
      const removed = list(body.remove).length;
      return `依赖调整（${title ? clip(title, TITLE_LIMIT) : "前置任务"}，+${added}/-${removed}）`;
    }
    case "plan_sprint":
      return `排期（${list(body.taskIds).length} 个任务）`;
    case "create_subtask": {
      const title = text(body.title);
      return title ? `新增子任务「${clip(title, TITLE_LIMIT)}」` : "新增子任务";
    }
    case "delete_subtask": {
      const title = text(body.title);
      return title ? `删除子任务「${clip(title, TITLE_LIMIT)}」` : "删除子任务";
    }
    case "delete_attachment": {
      const name = text(body.filename);
      return name ? `删除附件「${clip(name, TITLE_LIMIT)}」` : "删除附件";
    }
    case "attach_message_file_to_task": {
      const name = text(body.filename);
      const task = text(body.taskTitle);
      return `消息附件「${name ? clip(name, TITLE_LIMIT) : "文件"}」→ ${
        task ? `任务「${clip(task, TITLE_LIMIT)}」` : "任务附件"
      }`;
    }
    case "send_message": {
      const target = text(body.targetName);
      const filename = text(body.filename);
      return `发送消息给「${target ? clip(target, TITLE_LIMIT) : "对方"}」${
        filename ? `（附件 ${clip(filename, TITLE_LIMIT)}）` : ""
      }`;
    }
    case "forward_message": {
      const target = text(body.targetName);
      return `转发消息给「${target ? clip(target, TITLE_LIMIT) : "对方"}」`;
    }
    case "create_group_chat": {
      const name = text(body.name);
      const count = typeof body.memberCount === "number" ? body.memberCount : null;
      return `组建群聊「${name ? clip(name, TITLE_LIMIT) : "新群"}」${
        count !== null ? `（${count} 人）` : ""
      }`;
    }
    case "invite_to_group": {
      const group = text(body.groupName);
      const names = list(body.usernames)
        .map((n) => text(n))
        .filter((n): n is string => n !== null);
      const shown = names.slice(0, 3).map((n) => clip(n, TITLE_LIMIT));
      const more = names.length > shown.length ? "等" : "";
      return `邀请「${shown.length > 0 ? `${shown.join("、")}${more}` : "成员"}」进群「${
        group ? clip(group, TITLE_LIMIT) : "群聊"
      }」`;
    }
    case "create_resource_usage": {
      const name = text(body.resourceName);
      const team = text(body.teamName);
      const start = text(body.startTime);
      const end = text(body.endTime);
      return `登记占用「${name ? clip(name, TITLE_LIMIT) : "资源"}」${
        team ? `（${clip(team, TITLE_LIMIT)}）` : ""
      }${start ? ` ${start}${end ? ` → ${end}` : " 起"}` : ""}`;
    }
    case "end_resource_usage": {
      const name = text(body.resourceName);
      return `结束占用「${name ? clip(name, TITLE_LIMIT) : "资源"}」`;
    }
    case "create_label": {
      const name = text(body.name);
      const team = text(body.teamName);
      return `新建标签「${name ? clip(name, TITLE_LIMIT) : "标签"}」${
        team ? `（${clip(team, TITLE_LIMIT)}）` : ""
      }`;
    }
    case "update_label": {
      const from = text(body.currentName);
      const to = text(body.name);
      return `修改标签「${from ? clip(from, TITLE_LIMIT) : "标签"}」${
        to && to !== from ? ` → 「${clip(to, TITLE_LIMIT)}」` : ""
      }`;
    }
    case "delete_label": {
      const name = text(body.name);
      return `删除标签「${name ? clip(name, TITLE_LIMIT) : "标签"}」`;
    }
    case "edit_task_labels": {
      const title = text(body.taskTitle);
      return `任务标签「${title ? clip(title, TITLE_LIMIT) : "任务"}」（${
        list(body.labelIds).length
      } 个）`;
    }
    case "save_personal_context":
      return `个人上下文（${list(body.entries).length} 条）`;
    case "respond_group_invite": {
      const name = text(body.groupName);
      const action = body.accept === true ? "接受" : "拒绝";
      return `群邀请「${name ? clip(name, TITLE_LIMIT) : "未知群聊"}」${action}`;
    }
    default:
      return DRAFT_TOOL_LABELS[d.tool] ?? d.tool;
  }
}

/**
 * 「继续处理后续动作」发出去的那句话。必须自包含：
 * 模型看不到上一轮卡片上的编辑态，只会看到这句话 + 会话上文。
 */
export function buildContinuationText(params: {
  originalText: string;
  committed: DraftLike[];
  remaining: DraftLike[];
}): string {
  const original = clip(params.originalText, 500) || "（未记录）";
  const committed =
    params.committed.length > 0 ? params.committed.map(summarizeDraft).join("、") : "无";
  const remaining =
    params.remaining.length > 0 ? params.remaining.map(summarizeDraft).join("、") : "无";

  return `【继续上一轮请求】
原请求：「${original}」
已落库：${committed}
上一轮已展示但尚未确认的草案（不要重复生成，也不要改动它们）：${remaining}

请继续完成原请求：
1) 依赖已落库内容/新 id 的后续动作，先用读工具取最新数据再补拟；
2) 上一轮漏掉的独立动作可以补拟；
3) 已展示未确认的条目一律不要重复生成。
不要臆造 id。若没有剩余动作，简短说明即可。`;
}
