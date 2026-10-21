# Agent 写入 API（供 Claude Code 等外部程序调用）

这些端点让浏览器之外的程序以你的身份写入 AgileCampus——添加任务、填写完成情况、登记资源占用。

## 认证

所有 `/api/agent/*` 端点用 **Personal API Token** 认证（非浏览器 session）：

```
Authorization: Bearer <token>
```

在网页「设置 → 个人访问令牌」生成令牌，明文只显示一次。令牌权限等同于你本人：只能操作你有权限的团队/项目，越权返回 `403`。

约定两个环境变量：

- `AGILECAMPUS_URL`：本站地址，如 `http://localhost:3000`
- `AGILECAMPUS_TOKEN`：上面生成的令牌明文

## 端点

### 1. 新建任务 — `POST /api/agent/tasks`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `projectId` | uuid | 是 | 目标项目 |
| `title` | string | 是 | 任务标题 |
| `description` | string | 否 | 描述 |
| `assigneeId` | uuid | 否 | 负责人（须为团队成员） |
| `startDate` | string | 否 | 起始日 `YYYY-MM-DD`（供时间线排期） |
| `dueDate` | string | 否 | 截止日 `YYYY-MM-DD` |
| `milestoneId` | uuid | 否 | 里程碑（须属该项目） |
| `priority` | `low`\|`medium`\|`high` | 否 | 默认 `medium` |

日期可传 `null` 或空串，等价于「未设置」（不会进入 date 列，也不会 500）。本表同样适用于端点 9 / 11。

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/tasks" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"...","title":"撰写调研问卷","priority":"high"}'
```

### 2. 填写完成情况 — `POST /api/agent/tasks/complete`

将任务标记为 `done` 并附完成说明。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskId` | uuid | 是 | 目标任务 |
| `completionNote` | string | 是 | 完成说明 |

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/tasks/complete" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"...","completionNote":"已跑通全部演武，79 战皆捷"}'
```

### 3. 登记资源占用 — `POST /api/agent/resource-usage`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `teamId` | uuid | 是 | 目标团队 |
| `resourceName` | string | 是 | 资源名，如 `GPU-01` |
| `purpose` | string | 否 | 用途 |
| `startTime` | ISO 8601 | 是 | 开始时间，如 `2026-07-22T14:00:00Z` |
| `endTime` | ISO 8601 | 否 | 结束时间；省略 = 占用中 |

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/resource-usage" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"teamId":"...","resourceName":"GPU-01","purpose":"训练模型","startTime":"2026-07-22T14:00:00Z"}'
```

### 4. 列我的项目 — `GET /api/agent/projects`

返回令牌主人参与的全部项目（跨团队）及任务统计。无参数。

```bash
curl "$AGILECAMPUS_URL/api/agent/projects" -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"projects":[{"id":"...","name":"赤壁演习","status":"active","teamId":"...",
#     "teamName":"东吴实验室","taskTotal":12,"doneCount":5}]}
```

### 5. 新建项目 — `POST /api/agent/projects`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `teamId` | uuid | 是 | 目标团队（令牌主人须为该团队 admin） |
| `name` | string | 是 | 项目名 |
| `description` | string | 否 | 描述 |
| `startDate` / `endDate` | string | 否 | `YYYY-MM-DD` |

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/projects" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"teamId":"...","name":"夷陵之役","startDate":"2026-09-01"}'
```

### 6. 项目详情 — `GET /api/agent/projects/{projectId}`

返回项目本体 + 里程碑清单 + 任务状态计数。

```bash
curl "$AGILECAMPUS_URL/api/agent/projects/$PID" -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"id":"...","name":"赤壁演习","status":"active","myRole":"admin","taskTotal":12,
#     "byStatus":{"todo":5,"doing":2,"done":5},
#     "milestones":[{"id":"...","title":"中期答辩","status":"open","targetDate":"2026-09-01"}]}
```

### 7. 改项目 / 归档 — `PATCH /api/agent/projects/{projectId}`

仅团队 admin 可动。至少提供一个字段；传 `null` 表示清空该字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 项目名 |
| `description` | string \| null | 描述 |
| `startDate` / `endDate` | string \| null | `YYYY-MM-DD` |
| `status` | `active`\|`archived` | 归档用 `archived` |

```bash
curl -X PATCH "$AGILECAMPUS_URL/api/agent/projects/$PID" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"archived"}'
```

### 8. 列项目下的任务 — `GET /api/agent/projects/{projectId}/tasks`

可选查询参数：`status`（`todo`/`doing`/`done`）、`assigneeId`（uuid）、`dueBefore`（`YYYY-MM-DD`，含当日）。

```bash
curl "$AGILECAMPUS_URL/api/agent/projects/$PID/tasks?status=todo" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"tasks":[{"id":"...","title":"撰写问卷","status":"todo","priority":"high",
#     "dueDate":"2026-09-01","assigneeName":"周瑜","parentTaskId":null, ...}]}
```

### 9. 在项目下建任务 — `POST /api/agent/projects/{projectId}/tasks`

字段同端点 1，但 `projectId` 取自路径而非 body。端点 1（`POST /api/agent/tasks`）为旧约，仍可用。

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/projects/$PID/tasks" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"撰写调研问卷","priority":"high"}'
```

### 10. 任务详情 — `GET /api/agent/tasks/{taskId}`

含依赖两端（`predecessors` / `successors`），每项带 `id/title/status/parentTaskId`。

```bash
curl "$AGILECAMPUS_URL/api/agent/tasks/$TID" -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"id":"...","projectId":"...","title":"调研现有方案","status":"doing","priority":"medium",
#     "startDate":null,"dueDate":"2026-09-01","milestoneId":"...","parentTaskId":null,
#     "assigneeId":"...","assigneeName":"周瑜","completionNote":null,
#     "predecessors":[{"id":"...","title":"立题","status":"done","parentTaskId":null}],
#     "successors":[],
#     "createdAt":"2026-07-25T09:42:20.351Z","updatedAt":"2026-07-25T09:42:20.351Z"}
```

### 11. 在任务下建子任务 — `POST /api/agent/tasks/{taskId}/subtasks`

字段同端点 9。所属项目由父任务推得，**无须传 `projectId`**；父任务删除时子任务级联删除。

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/tasks/$TID/subtasks" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"子任务：设计接口","priority":"high"}'
# → {"id":"...","title":"子任务：设计接口","status":"todo","parentTaskId":"...","projectId":"..."}
```

### 12. 列任务的子任务 — `GET /api/agent/tasks/{taskId}/subtasks`

只列**直接子级**，不递归取孙级。

```bash
curl "$AGILECAMPUS_URL/api/agent/tasks/$TID/subtasks" -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"parentTaskId":"...","subtasks":[{"id":"...","title":"子任务：设计接口","status":"todo", ...}]}
```

### 13. 改任务详情 — `PATCH /api/agent/tasks/{taskId}`

至少提供一个字段。**`null` = 清空**，**空串 = 没给（不改）**。

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 非空 |
| `description` | string \| null | 描述 |
| `assigneeId` | uuid \| null | 负责人；须为团队成员 |
| `milestoneId` | uuid \| null | 里程碑；须属于该项目 |
| `startDate` / `dueDate` | `YYYY-MM-DD` \| null | 须满足先后顺序与项目周期 |
| `status` | `todo`\|`doing`\|`done` | |
| `priority` | `low`\|`medium`\|`high` | |
| `completionNote` | string \| null | 完成说明 |

不收 `projectId` / `parentTaskId` / `createdById` / `sortOrder`。teacher 只读（403）。
并发按 last-writer-wins，无版本号。

```bash
curl -X PATCH "$AGILECAMPUS_URL/api/agent/tasks/$TID" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"startDate":"2026-11-01","description":"补充调研范围"}'
# → {"id":"...","startDate":"2026-11-01","description":"补充调研范围", ... ,"updatedAt":"..."}
```

### 14. 调后置任务（依赖边） — `POST /api/agent/tasks/{taskId}/successors`

路径里的 id 是**前置任务**。语义是**增量**：`add` 只加、`remove` 只删，未提到的旧边原样保留。
两者相交时 **remove 优先**。后置任务**须与前置任务同级**（同一个 `parentTaskId`；顶层任务彼此同级）。

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/tasks/$TID/successors" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"add":["<uuid>"],"remove":["<uuid>"]}'
# → {"predecessorId":"...","added":["..."],"removed":["..."],
#     "successors":[{"id":"...","title":"...","status":"todo","parentTaskId":null}]}
```

护栏：自环与直接/间接环 → 400；跨项目后置 → 400；跨层级历史边**只读**，`remove` 它会
明确报 `跨层级后置任务不能通过此接口调整`（不是静默无效）。并发按 last-writer-wins。

### 15. 项目依赖图 — `GET /api/agent/projects/{projectId}/dependencies`

列出项目内全部依赖边，带两端标题、状态与 `crossLevel`（兼容早期跨层级数据）。

```bash
curl "$AGILECAMPUS_URL/api/agent/projects/$PID/dependencies" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"projectId":"...","dependencies":[
#     {"predecessorId":"...","predecessorTitle":"立题","predecessorStatus":"done",
#      "predecessorParentTaskId":null,"successorId":"...","successorTitle":"调研",
#      "successorStatus":"todo","successorParentTaskId":null,"crossLevel":false}]}
```

### 16. 联系人 — `GET /api/agent/contacts`

- 不带参数：列出我的私信联系人（含未读数、最近一条预览与方向）。
- `?username=foo`：按用户名**精确**查人（大小写不敏感），返回 `userId` 供发消息使用；不建会话、不改变未读。

```bash
curl "$AGILECAMPUS_URL/api/agent/contacts" -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"contacts":[{"peerId":"...","name":"周瑜","unread":0,"lastAt":"...","preview":"...","lastMine":false}]}

curl "$AGILECAMPUS_URL/api/agent/contacts?username=zhouyu" -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"user":{"id":"...","name":"zhouyu"}}
```

查无此人、查自己、空用户名 → `400`。

### 17. 读私信/群消息（只读） — `GET /api/agent/messages`

`peerId` 与 `groupId` **二选一**；`limit` 1–50（默认 20）。只读最近消息：
**不标已读、不推 `last_read_at`、不建联系人**。

```bash
curl "$AGILECAMPUS_URL/api/agent/messages?peerId=<userId>&limit=20" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"kind":"dm","peer":{"id":"...","name":"周瑜"},"hasMore":false,
#     "messages":[{"id":"...","mine":false,"content":"...","at":"...",
#                  "attachment":{"attachmentId":"...","filename":"设计稿.png","size":1024}}]}

curl "$AGILECAMPUS_URL/api/agent/messages?groupId=<groupId>" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"kind":"group","group":{"id":"...","name":"讨论组"},"messages":[...],"hasMore":false}
```

非群成员 → `403`；参数缺失或两者同时给出 → `400`。

### 18. 发私信/群消息 — `POST /api/agent/messages`

`toUserId` 与 `toGroupId` **二选一**；正文与附件至少其一。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `toUserId` | uuid | 二选一 | 私信收件人（不能是自己） |
| `toGroupId` | uuid | 二选一 | 群聊（须为成员） |
| `content` | string | 否 | 正文 |
| `attachment.source` | `task`\|`message` | 否 | `task`=任务附件（项目文件）；`message`=消息附件（转发文件） |
| `attachment.attachmentId` | uuid | 否 | 已有附件 id（**不接受二进制上传**，上传仍走网页） |

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/messages" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"toUserId":"<uuid>","content":"项目文件给你","attachment":{"source":"task","attachmentId":"<uuid>"}}'
# → {"sent":1,"targetType":"user","targetName":"周瑜"}
```

附件按 id 读字节后**复制**进 `dm_attachments`（跨表无外键），单文件 ≤10MB。
越权读附件或目标 → `403`；空消息 / 目标二选一不成立 → `400`。

### 19. 列我的群聊 — `GET /api/agent/groups`

```bash
curl "$AGILECAMPUS_URL/api/agent/groups" -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"groups":[{"groupId":"...","name":"讨论组","memberCount":3,"unread":0,
#               "lastAt":"...","preview":"...","lastSenderName":"周瑜"}]}
```

### 20. 建群 — `POST /api/agent/groups`

与网页建群一致：成员被**直接拉进群**（不是发邀请待接受）。`memberIds` 里的自己会被忽略；
可以传空数组，先建一个只有自己的群（之后再邀请）；群名 ≤30 字，成员 ≤50 人。

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/groups" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"讨论组","memberIds":["<uuid>","<uuid>"]}'
# → {"id":"...","name":"讨论组","ownerId":"...","memberCount":3,
#     "members":[{"userId":"...","name":"周瑜"}]}
```

### 21. 转发消息 — `POST /api/agent/messages/forward`

把一条已有私信/群消息连同附件原样转发。源消息只允许收发双方/群成员读取；
`sourceId` 必须与消息实际所属会话一致（私信填对端 `userId`，群聊填 `groupId`）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sourceType` | `dm`\|`group` | 是 | 源会话类型 |
| `sourceId` | uuid | 是 | 私信对端 userId / 群聊 groupId |
| `messageId` | uuid | 是 | 源消息 |
| `toUserId` / `toGroupId` | uuid | 二选一 | 转发目标 |

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/messages/forward" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"dm","sourceId":"<对端 userId>","messageId":"<uuid>","toGroupId":"<uuid>"}'
# → {"forwarded":1,"sourceType":"dm","sourceLabel":"与 周瑜 的私信",
#     "targetType":"group","targetName":"讨论组"}
```

非源消息参与者 → `403`；来源会话对不上 / 源消息为空 → `400`。

### 22. 任务附件 — `GET /api/agent/tasks/{taskId}/attachments`

列出任务的附件元数据（所有项目成员可读）。

```bash
curl "$AGILECAMPUS_URL/api/agent/tasks/<taskId>/attachments" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"taskId":"...","attachments":[{"id":"...","filename":"设计稿.png","mimeType":"image/png",
#     "size":1024,"createdAt":"...","uploaderName":"周瑜"}]}
```

### 23. 任务附件下载 / 删除 — `/api/agent/attachments/{attachmentId}`

```bash
curl -OJ "$AGILECAMPUS_URL/api/agent/attachments/<attachmentId>" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"      # 200，二进制 + Content-Disposition

curl -X DELETE "$AGILECAMPUS_URL/api/agent/attachments/<attachmentId>" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"      # → {"deleted":"<attachmentId>"}
```

下载权限同网页（项目成员）；删除需任务写权限。非成员 → `403`；不存在 → `404`（删除为 `400`）。

### 24. 消息附件下载 — `GET /api/agent/message-attachments/{attachmentId}`

私信收发双方、群聊成员可下载；回应为二进制文件（`Content-Disposition: attachment`）。
权限口径与网页消息附件一致。非参与者 → `403`。

### 25. 删除子任务 — `DELETE /api/agent/tasks/{taskId}/subtasks/{subtaskId}`

只删子任务；`taskId` 必须与该子任务实际的 `parentTaskId` 一致。删除会级联删掉它的下级子任务与依赖，不可恢复。

```bash
curl -X DELETE "$AGILECAMPUS_URL/api/agent/tasks/<taskId>/subtasks/<subtaskId>" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN"
# → {"deleted":"<subtaskId>","parentTaskId":"<taskId>"}
```

父任务对不上 → `400`；非项目成员 → `403`。

### 26. 邀请进群 — `POST /api/agent/groups/{groupId}/invites`

邀请一至多人进群。与网页一致：邀请进入**待处理**列表，对方接受后才入群（**不是直接拉人**）。
调用者须仍在群聊里；用户名精确匹配（大小写不敏感），可先用联系人接口查人。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `usernames` | string[] | 二选一 | 要邀请的用户名列表 |
| `username` | string | 二选一 | 只邀请一人时的简写 |

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/groups/<groupId>/invites" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"usernames":["zhouyu","xiaoqiao"]}'
# → {"invited":2,"groupName":"讨论组",
#     "invitees":[{"userId":"...","name":"zhouyu"},{"userId":"...","name":"xiaoqiao"}]}
```

已在群里 / 已邀请过 / 群满 / 查无此人 → `400`；非群成员 → `403`；`groupId` 非 uuid、未给用户名或未登录 → `400`/`401`。

## 响应与错误

- `200`：成功，返回创建/更新后的精简对象（含 `id`）。
- `400`：请求格式无效（缺字段、类型错、时间非法）。
- `401`：令牌缺失、畸形、伪造或已撤销。
- `403`：越权——令牌主人对目标项目/团队无权限。
- `500`：服务器错误，可重试。

## 安全说明

- 令牌库中只存 sha256 hash，明文只在生成时返回一次。
- 外部写入一律不被信任：`token → userId → lib 权限校验`，越权由业务层拒绝。
- 令牌泄露即在设置页撤销，立即失效。

## 定时提醒（cron）

`POST /api/cron/reminders` 由外部调度每日打一次，扫临期/逾期任务并飞书私信负责人。以 `CRON_SECRET` 鉴权：

    curl -X POST "$AGILECAMPUS_URL/api/cron/reminders" -H "Authorization: Bearer $CRON_SECRET"

NAS 部署可用 host crontab（每日 09:00）：

    0 9 * * * curl -fsS -X POST "http://localhost:3000/api/cron/reminders" -H "Authorization: Bearer <CRON_SECRET>" >/dev/null 2>&1
