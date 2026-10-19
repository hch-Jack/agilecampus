# 助手：消息文件进任务附件 + 项目子任务与附件管理 — 设计

日期：2026-10-19 ｜ 分支：`feat/agent-multi-action-message-reads`

## 一、要解决的事

1. **消息里的文件用不上**：工作台助手能读私信/群聊，但 `read_messages` 只回附件文件名与大小，
   没有 id，也没有任何工具能把文件变成任务附件。
2. **项目助手管不了子任务**：底层已有 `createSubtask` / `listSubtasks` / `deleteTask`，
   但工具面没有「新建子任务」「删除子任务」；修改只能靠 `update_tasks`（可用，但提示词没说明）。
3. **项目助手管不了附件**：底层 `listAttachments` / `deleteAttachment` 已有，工具面完全没有入口。

**本次没有 schema 变更** → 不需要 `db:push`；测试库若落后仍按老规矩 `npm run db:push:test`。

## 二、不变量

1. **写操作一律走草案**：新增/复制/删除的 `execute` 只返回 `{__draft:true, tool, draft}`，
   落库只经 `/api/chat/commit` → `commitDraft` / `commitPersonalDraft`，服务端重解 zod + 重校权限。
2. **身份只来自 session**：工具入参没有 actorId；消息附件权限按「私信收发双方 / 群成员」，
   任务写权限按 `requireTaskWrite`。
3. **不新增发消息能力**，也不接收二进制上传。
4. **删除不可逆**：删除子任务与附件都是不可恢复操作，卡片必须明确警告后才允许确认。

## 三、消息文件 → 任务附件

### 3.1 数据模型事实

- `dm_attachments`（消息附件）与 `task_attachments`（任务附件）是**两张独立表**，都直接存 `bytea`，
  二者没有外键关联。
- 因此「添加到任务附件」只能是**复制字节新建一行**，不能引用共享同一行：
  消息删除/清理不会弄丢任务附件，任务附件删除也不影响聊天记录。代价是同一文件存两份（≤10MB）。

### 3.2 lib

- `src/lib/dm.ts`
  - 抽出 `requireDmAttachmentAccess(actorId, attachmentId)`：私信收发双方或群成员，否则 `ForbiddenError`。
  - 新增 `getDmAttachmentMeta(actorId, attachmentId)`：只取 id/文件名/MIME/大小，**不含 blob**。
  - `getDmAttachmentForDownload` 复用同一权限函数；返回形状去掉无用的 `senderId/recipientId: null`。
- `src/lib/attachment.ts`
  - 新增 `getAttachmentMeta(actorId, attachmentId)`：附件 + 任务标题 + 项目 id，成员可读。
  - `deleteAttachment(actorId, attachmentId, opts?: { projectId? })`：带 `projectId` 时校验附件归属，
    跨项目直接 `AppError("附件不属于该项目")`。
  - 新增 `copyMessageAttachmentToTask(actorId, messageAttachmentId, taskId)`：
    `getDmAttachmentForDownload`（验消息附件可读）→ `uploadAttachment`（验任务写、10MB、记 `attachment_added`）。

### 3.3 工具（仅个人 scope）

| 工具 | 入参 | 草案 |
| --- | --- | --- |
| `attach_message_file_to_task` | `{ attachmentId, taskId }` | `{ attachmentId, taskId, filename, size, taskTitle }` |

- 拟稿时先 `getDmAttachmentMeta` 校验可读、`getTaskDetailBundle` 校验任务可见、`requireTaskWrite` 校验可写。
- `read_messages` 的 `attachment` 补 `attachmentId`（DM 与群聊两处），描述写明可据此复制。
- 常量 `ATTACH_MESSAGE_TOOL` **只进 `COMMIT_TOOL_NAMES`，不进 `WRITE_TOOL_NAMES`**：
  项目页落库口天然拒收，`commitPersonalDraft` 在拆 `projectId` 之前分派。

### 3.4 卡片

- 「消息文件添加为任务附件」：展示文件名/大小/目标任务；说明「确认后复制一份，删消息不影响」。
- 缺 `attachmentId` 或 `taskId` 时禁用确认并提示重拟。

## 四、项目子任务操作

### 4.1 工具

| 工具 | 入参 | 草案 | 落库 |
| --- | --- | --- | --- |
| `create_subtask` | `{ parentTaskId, title, description?, assigneeId?, startDate?, dueDate?, milestoneId?, priority? }` | 带 `parentTitle` / `projectId` | 重验父任务属于当前项目 → `createSubtask` |
| `delete_subtask` | `{ taskId }` | 带 `title` / `parentTitle` | 重验属于当前项目且**确有父任务** → `deleteTask` |
| 修改子任务 | 复用 `update_tasks` | — | 既有逻辑 |

- `create_subtask` / `delete_subtask` 进 `WRITE_TOOL_NAMES`，项目页落库口直接可用。
- 删除是**只删子任务**：主任务被工具层与落库口双重拒绝；其下级子任务与依赖按 `deleteTask` 既有语义级联删除，
  卡片写明不可恢复。
- `create_subtask` 进「可续做」工具集（派生新 id）；`delete_subtask` 不进。
- 提示词明确「改子任务与改普通任务相同，用 `update_tasks`」。

## 五、项目附件管理

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `list_attachments` | `{ taskId }` | 只读；先校验任务属于当前项目，再返回 `attachmentId`/文件名/大小/上传者/时间 |
| `delete_attachment` | `{ attachmentId }` | 草案；拟稿时校验归属与写权限，落库再校验 |

- `delete_attachment` 进 `WRITE_TOOL_NAMES`。
- 不做重命名、不做助手侧上传、不开放 REST 附件端点（见 BACKLOG）。

## 六、提示词与快照

- 工具选用表补：子任务新建/删除/修改、附件查看/删除、消息文件复制。
- `SCOPE_NOTES.project`：说明子任务与附件能力；明确项目助手不能读消息、没有消息附件工具。
- `SCOPE_NOTES.personal`：说明 `read_messages` 返回 `attachmentId`，用户明确要求时才能复制成任务附件。
- 个人快照 `messageBlock` 补一句工具指引；仍只放计数，不放开正文/文件名。

## 七、测试

新增 `tests/agent-subtasks-attachments.test.ts`：

- 项目：`create_subtask` 草案不落库、确认后挂到父任务；跨项目父任务被拒。
- 项目：`delete_subtask` 只删子任务、级联删孙任务；主任务在工具层与落库口都被拒。
- 项目：`list_attachments` 只列当前项目；`delete_attachment` 草案不删、确认后删除；跨项目任务/附件被拒。
- 个人：DM 与群聊文件都能经 `read_messages` 取 `attachmentId`，草案确认后字节、文件名、MIME 一致；
  外人拿他人附件 id 被拒；未知 id 报「附件不存在」。

同步更新：`agent-write-tools`（`WRITE_TOOL_NAMES` 9 件）、`agent-personal-tools`（个人 19 件、
`COMMIT_TOOL_NAMES` 含消息附件工具）、`agent-continuation`（新摘要与续做集合）。

## 八、不做的事

- 加表/加列、`db:push`（生产）；助手侧文件上传；附件重命名；附件 REST 端点；
  子任务「提升为主任务」/换父任务（reparent）；把子任务/附件管理工具复制到工作台助手；
  把消息附件复制做成共享引用；自动去重同名附件。
