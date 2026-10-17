import {
  pgTable,
  pgEnum,
  uuid,
  text,
  uniqueIndex,
  primaryKey,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  check,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
// 相对路径而非 `@/lib/time`：schema 由 drizzle-kit 独立加载，那边没有配路径别名
import { dbWallClockToInstant, instantToDbWallClock, isValidTimeZone } from "../lib/time";

// 二进制大对象：附件文件内容直存 PostgreSQL（团队自建/NAS 部署，随库备份免运维）
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ------------------------------------------------------------------ 时间列

/**
 * 本连接的 PG 会话时区（`SHOW timezone`）。由 `src/db/index.ts` 连上库后探明注入。
 *
 * 初值 `UTC` 是兜底：一来那是 drizzle 内置的假设，二来探不到时区时（库还没起来）
 * 至少与改动前的行为一致，且后续任何查询本来都会失败。
 */
let dbTimeZone = "UTC";

/** 探明会话时区后调用；非法值一律忽略，保留原值 */
export function setDbTimeZone(tz: unknown): void {
  if (isValidTimeZone(tz)) dbTimeZone = tz;
}

export function getDbTimeZone(): string {
  return dbTimeZone;
}

/**
 * **无时区 `timestamp` 列**（站内所有时间列都是它，即钟面读数，本身不带偏移）。
 *
 * 为什么不用 drizzle 自带的 `timestamp()`：它对这类列一律 `new Date(值 + "+0000")`，
 * 也就是**假定钟面是 UTC**；而 PG 自己写时间时（`now()` / `defaultNow()`）落的是
 * **会话时区**的钟面。两边口径不一致，凡是数据库写的时间就整整差一个偏移 ——
 * 库会话在 +08 时，页面上每个「创建于/更新于/活动日志」都慢 8 小时，
 * 而库会话在 UTC 时又恰好对的（`docker-compose.prod.yml` 那套就是）。
 *
 * 这里两个方向都按会话时区显式换算：写的时候自己先把钟面算好（不带偏移，PG 便不会再动它），
 * 读的时候再按同一个时区还原。于是**库会话时区配成什么都不会错**，
 * 「PG 时区必须等于 Node 时区」这个暗礁也就不存在了。
 *
 * 类型仍是 `timestamp`，物理 schema 不变，`db:push` 不会产生任何 ALTER。
 */
const dbWallClock = customType<{ data: Date; driverData: string }>({
  dataType: () => "timestamp",
  toDriver: (value) => instantToDbWallClock(dbTimeZone, value as Date),
  fromDriver: (value) =>
    (value as unknown) instanceof Date
      ? (value as unknown as Date)
      : dbWallClockToInstant(dbTimeZone, String(value)),
});

/** 无默认值的时间列（如 `start_time`、`feishu_bound_at`） */
export const dbTimestamp = (name: string) => dbWallClock(name);

/** 默认取 DB 时钟的时间列；`default(sql`now()`)` 与原来的 `.defaultNow()` 生成同一条 DDL */
export const dbTimestampNow = (name: string) => dbWallClock(name).default(sql`now()`);

export const teamRoleEnum = pgEnum("team_role", ["admin", "teacher", "student"]);
export type TeamRole = (typeof teamRoleEnum.enumValues)[number];

// 注册时自填的身份，存在用户上、跨团队复用，可空（存量用户与飞书自动建号用户为 NULL）。
// 刻意不含 admin：admin 是团队内权限，只能由建团或团队管理员授予，
// 枚举里没有这个值，注册路径就无法自助提权。
export const userIdentityEnum = pgEnum("user_identity", ["teacher", "student"]);
export type UserIdentity = (typeof userIdentityEnum.enumValues)[number];

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    // 用户名（站内昵称）：全局唯一——私信按用户名精准定位到人，注册查重 + 此索引兜底
    name: text("name").notNull(),
    identity: userIdentityEnum("identity"),
    // 飞书绑定（一对一，可空=未绑定）：open_id 为应用内用户唯一标识，发私信用之
    feishuOpenId: text("feishu_open_id").unique(),
    feishuName: text("feishu_name"),
    feishuBoundAt: dbTimestamp("feishu_bound_at"),
    // 时区偏好：IANA 名（如 Asia/Shanghai），或 "auto" = 跟随浏览器（见 lib/time.ts）。
    // 默认中国时间 —— 部署容器跑在 UTC，不给默认值的话用户看到的时间会慢 8 小时。
    // 这里写字面量而非常量：schema 由 drizzle-kit 独立加载，不引应用侧的模块。
    // 两份值必须一致，有 tests/time.test.ts 盯着。
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    // 助手「记得多少上文」：每轮把会话里最近 N 条聊天记录一并喂给模型（0 = 完全不看历史）。
    // 一个数供两个 scope 共用 —— 工作台助手与项目页助手读的是同一条偏好。
    // 默认 10（约五轮问答）；上下限与钳制在 lib/agent/memory.ts 收口，别在别处写死数字。
    aiHistoryLimit: integer("ai_history_limit").notNull().default(10),
    // 头像：PNG/JPEG/WebP 直存库内（与私信附件同构），经 /api/avatars/[userId] 流出。
    // avatarUpdatedAt 兼作缓存破坏版本号（URL 带 ?v=），换头像即覆盖旧图。
    avatarData: bytea("avatar_data"),
    avatarMime: text("avatar_mime"),
    avatarUpdatedAt: dbTimestamp("avatar_updated_at"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_name_unique").on(t.name)],
);

// 私信附件：与任务附件同构，内容（bytea）直存库内，单文件上限由应用层校验（lib/dm.ts，10MB）。
// 附件随消息先落库再被消息引用；站内无删除入口，留档即永久。
export const dmAttachments = pgTable("dm_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  uploaderId: uuid("uploader_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  size: integer("size").notNull(),
  data: bytea("data").notNull(),
  createdAt: dbTimestampNow("created_at").notNull(),
});

// 用户间私信（点对点，无群聊）：content 与 attachmentId 至少其一非空（应用层校验）。
// readAt 由收件方打开会话时批量置为 now()——未读数与已读标记共用这一个字段。
export const dmMessages = pgTable(
  "dm_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    attachmentId: uuid("attachment_id").references(() => dmAttachments.id, {
      onDelete: "set null",
    }),
    readAt: dbTimestamp("read_at"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    index("dm_messages_recipient_idx").on(t.recipientId),
    index("dm_messages_sender_idx").on(t.senderId),
    index("dm_messages_attachment_idx").on(t.attachmentId),
  ],
);

// 会话列表（消息栏）：搜索添加或收发过消息即建立一行，双方各自持有。
// 仅作列表成员与排序之用，已读状态记在消息上。
export const dmContacts = pgTable(
  "dm_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    peerId: uuid("peer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("dm_contacts_owner_peer_unique").on(t.ownerId, t.peerId),
    index("dm_contacts_owner_idx").on(t.ownerId),
  ],
);

// —— 群聊（微信/QQ 式）。表名带 dm_ 前缀属私信域：conversations/messages 已被 AI 会话占用。——

// 群：名称 1..30 字由应用层校验（lib/group-chat.ts）；解散即删行，成员/消息/邀请随 cascade 清掉
export const dmGroups = pgTable("dm_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: dbTimestampNow("created_at").notNull(),
});

// 群成员：lastReadAt 是未读基线——进群/接受邀请/打开会话时置为 DB 时钟 now()，
// 未读 = 该时刻**之后**别人发的消息。所有写入都用 DB 时钟（列默认值或 sql`now()`），
// 绝不传 JS Date，避免与 dbWallClock 的会话时区换算口径打架。
export const dmGroupMembers = pgTable(
  "dm_group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => dmGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: dbTimestampNow("last_read_at").notNull(),
    joinedAt: dbTimestampNow("joined_at").notNull(),
  },
  (t) => [
    uniqueIndex("dm_group_members_group_user_unique").on(t.groupId, t.userId),
    index("dm_group_members_user_idx").on(t.userId),
  ],
);

// 群消息：content 与 attachmentId 至少其一非空（应用层校验，同 dm_messages）；
// 附件复用 dm_attachments。群聊无已读回执，已读状态只记在成员表的 lastReadAt 上。
export const dmGroupMessages = pgTable(
  "dm_group_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => dmGroups.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    attachmentId: uuid("attachment_id").references(() => dmAttachments.id, {
      onDelete: "set null",
    }),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    index("dm_group_messages_group_created_idx").on(t.groupId, t.createdAt),
    index("dm_group_messages_attachment_idx").on(t.attachmentId),
  ],
);

// 群邀请：**行存在即待处理**，接受/拒绝都删行——(群, 被邀请人) 唯一索引即保证
// 「一人最多一份待处理邀请」，拒绝后行已删可重邀，无需 status 列。
export const dmGroupInvites = pgTable(
  "dm_group_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => dmGroups.id, { onDelete: "cascade" }),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inviteeId: uuid("invitee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("dm_group_invites_group_invitee_unique").on(t.groupId, t.inviteeId),
    index("dm_group_invites_invitee_idx").on(t.inviteeId),
  ],
);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  inviteCode: text("invite_code").notNull().unique(),
  createdAt: dbTimestampNow("created_at").notNull(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: teamRoleEnum("role").notNull().default("student"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [uniqueIndex("team_members_team_user_unique").on(t.teamId, t.userId)],
);

export const projectStatusEnum = pgEnum("project_status", ["active", "archived"]);
export const milestoneStatusEnum = pgEnum("milestone_status", ["open", "done"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "doing", "done"]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high"]);
export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];
export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
export type TaskPriority = (typeof taskPriorityEnum.enumValues)[number];

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatusEnum("status").notNull().default("active"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [index("projects_team_idx").on(t.teamId)],
);

export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    targetDate: date("target_date"),
    status: milestoneStatusEnum("status").notNull().default("open"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [index("milestones_project_idx").on(t.projectId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    milestoneId: uuid("milestone_id").references(() => milestones.id, {
      onDelete: "set null",
    }),
    // 子任务层级：自引用，空＝顶层任务。父任务删则子任务随之（cascade）。
    // 自引用外键须显式标注 AnyPgColumn，否则 TS 推断成环。
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    completionNote: text("completion_note"),
    assigneeId: uuid("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    startDate: date("start_date"),
    dueDate: date("due_date"),
    status: taskStatusEnum("status").notNull().default("todo"),
    priority: taskPriorityEnum("priority").notNull().default("medium"),
    sortOrder: doublePrecision("sort_order").notNull().default(0),
    createdAt: dbTimestampNow("created_at").notNull(),
    updatedAt: dbTimestampNow("updated_at").notNull(),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_assignee_idx").on(t.assigneeId),
    index("tasks_parent_idx").on(t.parentTaskId),
  ],
);

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "tool"]);
export type MessageRole = (typeof messageRoleEnum.enumValues)[number];

// 会话两种形态，同表承载 —— messages 只认 conversationId，分表就得把这条外键劈成两半。
// project：项目助手（项目页），**全员共享**，projectId 必填、ownerId 为空。
// personal：控制台助手（工作台），**严格按 ownerId 隔离**，projectId 为空。
// 两者由下面的 CHECK 与唯一索引共同围住，库层面就不可能出现「既是项目又是个人」的脏行。
export const conversationKindEnum = pgEnum("conversation_kind", ["project", "personal"]);
export type ConversationKind = (typeof conversationKindEnum.enumValues)[number];

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: conversationKindEnum("kind").notNull().default("project"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    index("conversations_project_idx").on(t.projectId),
    // ownerId 为 NULL 的行（项目会话）互不相犯：PG 的唯一索引视多个 NULL 为彼此不同，
    // 于是「项目会话不限条数、个人会话每人恰一条」这一个索引就全包了。
    uniqueIndex("conversations_owner_unique").on(t.ownerId),
    check(
      "conversations_scope_chk",
      sql`(${t.kind} = 'project' AND ${t.projectId} IS NOT NULL AND ${t.ownerId} IS NULL)
        OR (${t.kind} = 'personal' AND ${t.projectId} IS NULL AND ${t.ownerId} IS NOT NULL)`,
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId)],
);

// ------------------------------------------------------- 个人上下文

// 个人上下文：每人自记的一组背景（研究方向、当下在忙什么、协作偏好…），喂给 AI 助手。
// shared（默认）会进**项目助手**的系统提示 —— 本项目团队所有人都能通过助手看到它；
// private 只进本人的控制台助手。默认 shared 是刻意的：团队助手要「知道每个人在做什么」，
// 逐条可退回 private 是把该由用户决定的那部分留给他自己。
export const personalContextVisibilityEnum = pgEnum("personal_context_visibility", [
  "shared",
  "private",
]);
export type PersonalContextVisibility = (typeof personalContextVisibilityEnum.enumValues)[number];

// manual = 用户自己在界面上填的；agent = 助手拟草案、用户点确认后落的（界面据此标来路）
export const personalContextSourceEnum = pgEnum("personal_context_source", ["manual", "agent"]);
export type PersonalContextSource = (typeof personalContextSourceEnum.enumValues)[number];

export const personalContexts = pgTable(
  "personal_contexts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    visibility: personalContextVisibilityEnum("visibility").notNull().default("shared"),
    source: personalContextSourceEnum("source").notNull().default("manual"),
    createdAt: dbTimestampNow("created_at").notNull(),
    updatedAt: dbTimestampNow("updated_at").notNull(),
  },
  (t) => [index("personal_contexts_user_idx").on(t.userId, t.visibility)],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    predecessorId: uuid("predecessor_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    successorId: uuid("successor_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("task_dep_pair_unique").on(t.predecessorId, t.successorId),
    index("task_dep_predecessor_idx").on(t.predecessorId),
  ],
);

// Personal API Token：CC 等浏览器外调用的认证凭据。
// 明文只生成时返回一次，库中仅存 sha256 hash（高熵 token 无需 bcrypt，且 hash 可建唯一索引供 O(1) 查验）。
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: dbTimestampNow("created_at").notNull(),
    lastUsedAt: dbTimestamp("last_used_at"),
    revokedAt: dbTimestamp("revoked_at"),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

// 资源占用登记：团队共享资源（服务器/算力等）的占用记录，纯登记无审批。
// endTime 可空=占用中；时长 = endTime - startTime（结束后计算）。
export const resourceUsages = pgTable(
  "resource_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceName: text("resource_name").notNull(),
    purpose: text("purpose"),
    startTime: dbTimestamp("start_time").notNull(),
    endTime: dbTimestamp("end_time"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    index("resource_usages_team_idx").on(t.teamId),
    index("resource_usages_user_idx").on(t.userId),
  ],
);

export const labelColorEnum = pgEnum("label_color", [
  "slate",
  "red",
  "amber",
  "green",
  "blue",
  "violet",
  "pink",
]);
export type LabelColor = (typeof labelColorEnum.enumValues)[number];

// 标签挂在团队而非项目：实验室内项目多且同质，共享一套免去每建一项目重建之苦。
// 唯一索引建在普通两列，大小写不敏感去重由 lib/label.ts 的 lower() 查询承担。
export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: labelColorEnum("color").notNull().default("slate"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("labels_team_name_unique").on(t.teamId, t.name),
    index("labels_team_idx").on(t.teamId),
  ],
);

export const taskLabels = pgTable(
  "task_labels",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.labelId] }),
    index("task_labels_label_idx").on(t.labelId),
  ],
);

// 任务附件：文件内容（bytea）直存库内，单文件上限由应用层校验（lib/attachment.ts，10MB）。
// 任务删除时附件级联消失。
export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => users.id),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [index("task_attachments_task_idx").on(t.taskId)],
);

// 任务动态：谁在何时对任务做了什么（创建/字段变更/子任务增改/附件增删）。
// 写入由 lib/task.ts 与 lib/attachment.ts 的写操作埋点承担，读端按 taskId 倒序取。
export const taskActivities = pgTable(
  "task_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    // type=field 时记变更字段名；其余类型为空
    field: text("field"),
    // 展示用文本（人名/中文名称/文件名），非裸 id；type=field 时为旧值→新值
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [index("task_activities_task_idx").on(t.taskId)],
);

// 动态流「已读/清除」标记：某用户在某条动态流（scope）里读到的最新时刻，未读 = 该时刻之后的动态条数。
// scope 取值："workbench"（工作台）或 "project:<项目id>"（项目页），两条流各记各的、互不影响。
// 没有标记 = 视为全部已读（功能上线时不给存量用户灌一屏未读）。
// cleared_at = 「清除记录」时刻：只影响该用户自己看到的动态流（隐藏该时刻前的记录），
// 库内数据与他人视图不动；此后新产生的记录照常显示。
export const feedReads = pgTable(
  "feed_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    lastReadAt: dbTimestampNow("last_read_at").notNull(),
    clearedAt: dbTimestamp("cleared_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope] })],
);

// 任务留言板（评论）：团队成员可在任务详情页留言讨论。
// 任务删除时留言级联消失。
export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: dbTimestampNow("created_at").notNull(),
  },
  (t) => [index("task_comments_task_idx").on(t.taskId)],
);
