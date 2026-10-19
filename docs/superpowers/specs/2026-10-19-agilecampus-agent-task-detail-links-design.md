# 助手：任务起始日 + 任务详情 + 后置任务（依赖） — 设计

日期：2026-10-19 ｜ 分支：`feat/agent-task-detail-links`

## 一、要解决的事

1. **修 bug**：项目助手「添加任务」**没有起始日** —— 工具 `decompose_tasks` 的 task schema 与
   落库 schema 都没有 `startDate`，而底层 `createTask` 早已支持。
2. **任务详情管理**：助手只有一个 `list_tasks`（仅 id/title/status/priority/dueDate/assigneeName），
   读不到描述、起止日、里程碑、父任务、标签、子任务、依赖；也改不了描述/起始日/完成说明。
3. **后置任务管理（＝关系图/流程图）**：依赖能力在仓库里已经齐了（`task_dependencies` 表、
   `setTaskSuccessors` 的同级与直接/间接环校验、`listProjectDependencies`、`/graph` 与 `/flow` 页），
   **缺的只是助手工具层与对外 REST**。

已与用户确认的三条口径：

| 决策点 | 结论 |
| --- | --- |
| 依赖边层级 | **沿用「后置任务须与前置任务同级（同 parentTaskId）」**，不改 lib 校验 |
| 助手写后置任务 | **增量增删（add / remove）**，不做全量替换（避免模型漏列旧边导致误删） |
| 对外 API | **同时开到 `/api/agent/*`**（个人令牌 REST），并同步文档与 skill |

**本次没有任何 schema 变更** → 不需要 `db:push`，`tests/helpers.ts` 的 TRUNCATE 也不必改。

## 二、不变量

1. **写操作一律走草案。** 写工具的 `execute` 只返回 `{__draft:true, tool, draft}` 信封，**绝不落库**；
   落库只经 `/api/chat/commit` → `commitDraft` / `commitPersonalDraft`，服务端重解 zod + 重校权限。
2. **三处 schema 必须同时改。** AI 工具 `inputSchema` → 落库 zod → 卡片字段；zod object 默认**剥离**
   未声明字段，漏一处就静默丢字段。
3. **工具层宽松、落库层收紧。** `z.preprocess` / `z.iso.date()` 转 JSON Schema 不稳，工具 schema 保持
   字符串，日期格式在 `commit.ts` / `lib/agent/validation.ts` 收口。
4. **存量形状别改坏。** `listProjectDependencies` 的 `{predecessorId, successorId}` 被图页面与测试钉着，
   新增带标题的版本另开函数；`GET /tasks/{id}` 只**追加**依赖两端。

## 三、lib（`src/lib/task.ts`）

- `TaskLink = { id; title; status; parentTaskId }`
- `listTaskLinks(actorId, taskId)` → `{ predecessors, successors }`；任务不存在先报「任务不存在」，
  权限口径同 `getTaskDetail`。
- `listProjectDependenciesDetailed(actorId, projectId)` → 边 + 两端 `title/status/parentTaskId`
  + `crossLevel`（`alias(tasks, "pred" / "succ")` 两次 join）。
- `getTaskDetailBundle(actorId, taskId, opts?: { projectId? })` = 详情 + 子任务 + 前后置 +
  里程碑/父任务标题；`opts.projectId` 不匹配抛「任务不属于该项目」（项目 scope 防串项目）。
- `applyTaskSuccessorDelta(actorId, predecessorId, { add?, remove? }, opts?)`：
  - 去重；**add ∩ remove 时 remove 优先**（用户点名要删的边不应被同一次请求加回来）；
    两者都空 → 「没有要调整的后置任务」。
  - 读任务 → `opts.projectId` 校验 → `requireTaskWrite`（teacher 只读）。
  - 按 `parentTaskId` 分出**同级集合**与**跨层级历史边**；`remove` 命中历史边 → **明确报错**
    「跨层级后置任务不能通过此接口调整」。否则 `preserve` 选项会让删除静默无效，接口返回成功但边还在。
  - `next = 同级集合 - remove ∪ add`；自环本地先拦，同级/跨项目/间接环交给 `setTaskSuccessors`。
  - 调 `setTaskSuccessors(..., { preserveCrossLevelIfSiblingSetUnchanged: true })`。
  - 返回 `{ predecessorId, added, removed, successors }`；并发按 last-writer-wins，
    **不拿 `task.updatedAt` 冒充边版本**。

## 四、REST（`src/app/api/agent/**`）

共享 schema 在 `src/lib/agent/validation.ts`：

- `optionalDateInput`：`""` / `null` / 缺省 → 未给；否则 `YYYY-MM-DD`。给三个建任务端点用
  （顺手修掉「空串直通 PG date 列 → 500」）。
- `nullableDatePatch` / `nullableTextPatch`：`""` → 没给（不改），`null` → 清空。

| 端点 | 说明 |
| --- | --- |
| `PATCH /api/agent/tasks/{taskId}` | 白名单：`title/description/assigneeId/milestoneId/startDate/dueDate/status/priority/completionNote`；不收 `projectId/parentTaskId/createdById/sortOrder`；空 patch 400「至少提供一个待改字段」；不加乐观锁 |
| `POST /api/agent/tasks/{taskId}/successors` | 路径 id 是**前置任务**；body `{ add?, remove? }`；返回 `{predecessorId, added, removed, successors}` |
| `GET /api/agent/projects/{projectId}/dependencies` | 带两端标题/状态/`crossLevel` 的边 |
| `GET /api/agent/tasks/{taskId}` | 追加 `predecessors` / `successors`（不加 subtasks） |

## 五、助手工具（`src/lib/agent/tools.ts`）

读：

- `get_task_detail`：**两个 scope 都只收 `{ taskId }`**（任务 id 全局唯一、权限内部重校）；
  项目版额外把当前 `projectId` 传给 `getTaskDetailBundle` 防串项目。
- `list_dependencies`：项目版 `{}`；个人版 `{ projectId }`。
- `list_tasks` 返回补 `startDate`。

写：

- `decompose_tasks` 的 task 增加 `startDate`（两个 scope）。
- `update_tasks.patch` 增加 `description / startDate / completionNote`（两个 scope，`.nullable()`：
  传 `null` 表示清空）。
- 新增 **`edit_task_links(predecessorId, add?, remove?)`**（个人版多一个 `projectId`）：
  - `execute` 先读任务与现有边，草案带展示数据：
    `{ projectId, predecessorId, predecessorTitle, predecessorParentTaskId,
       currentSuccessors: [{id,title,status,parentTaskId}], add, remove }`。
  - 空操作在**工具调用当轮**就报错，不留一张点了必炸的卡；项目归属也在这一轮校验。
  - `WRITE_TOOL_NAMES` 加入它（5 → 6）。
- `commit.ts` 新增 `linkDraftSchema`（`{ predecessorId: uuid, add: uuid[], remove: uuid[] }`，
  **不要 `.strict()`**，展示字段自动剥离）+ switch case → `applyTaskSuccessorDelta`，
  返回 `added + removed` 计数。

提示词 `orchestrator.ts`：工具选用表补三件新工具；军规补「改详情/依赖前先读详情、后置必须同级、
增量不要整表替换、清空传 null」；`SCOPE_NOTES` 说明 `get_task_detail` 只需 taskId。

## 六、卡片与选项

- `Option` 增 `parentTaskId`；`OptionMap` / `NO_OPTIONS` / `DraftOptions` 增 `tasks`。
- 项目页 `defaultOptions` 与 `collectDraftOptions` 都补任务选项（个人版靠草案顶层 `projectId`）。
- decompose 行加起始日输入（带 `aria-label`/`title`）。
- `PATCH_FIELDS` 加 `startDate`(date)、`description`/`completionNote`(textarea)；清空送 `null`。
- 新增 `edit_task_links` 卡片：前置任务标题；现有后置（同级可移除、跨层级标「只读」徽章）；
  新增（按 `parentTaskId` 滤同级候选，点选切换）；空操作或 add∩remove 时禁用确认并写明原因。
  文案说明「确认后按当前库里的最新状态增删，未提到的旧后置不会被动」。

## 七、不做的事

- 跨层级依赖的新建；`parentTaskId` 编辑；依赖边 / PATCH 的乐观锁。
- 改 `listProjectDependencies` 的返回形状；`GET /tasks/{id}` 塞 subtasks。
- 底层 `setTaskSuccessors` 的全量替换语义（同级集合一变，旧边含历史跨层级边仍会先删再插）。
- 真实模型回合验收：本机无 `DEEPSEEK_API_KEY`，工具选择与 `null` 清空未在真模型上跑过；
  部署后需在有 key 的环境补验一轮（若 provider 对 `anyOf:[string,null]` 挑食，
  先把三处 nullable 退回 `z.string().optional()`）。
