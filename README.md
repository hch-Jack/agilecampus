# AgileCampus 敏捷校园

面向高校实验室 / 教学团队的 **Agent 驱动轻量项目管理平台**。看板协作、AI 项目助手、资源占用登记、时间线甘特，并支持 Claude Code 等外部程序经 Personal API Token 直接写入。

## 功能特性

- **团队与角色**：创建/加入团队，admin / teacher / student 三级权限
- **站内私信**：QQ 式消息栏——搜用户名找人开聊（用户名全站唯一，注册即锁定，保证精准命中一人），点对点收发消息与文件（单文件 ≤10MB），未读角标与已读标记，收发的每条消息永久留档
- **项目看板**：里程碑 + 拖拽看板 + 任务增强（描述/完成情况/起止日/后置任务）+ 标签筛选与四维度分组（状态/指派人/优先级/里程碑，各分组下拖拽皆生效）
- **跨项目总览**：`/projects` 聚合我所在全部团队的项目与任务进度
- **AI 助手（右侧常驻面板）**：顶栏「AI 助手」按钮开合——桌面端挤压正文、移动端覆盖；对话是**私人会话**（队友看不到），可开多条，面板顶部有会话列表（切换/改名/删除）；每条消息旁可删掉**整轮**问答；设置页可清空全部个人聊天记录。跨项目问事；在项目页里自动带上当前项目快照，并放出项目专属工具（项目动态、留言板、旧助手对话、子任务、附件删除），但对话仍只属于你。能**只读**查看私信、群聊、群邀请与工作台动态，并把消息里要做的事提炼成任务/上下文草案；消息里的文件可经草案**复制为任务附件**；能按用户名找联系人、拟发送私信/群消息、把消息或项目文件转发给个人/群聊、组建群聊、邀请别人进群——**发送/邀请类动作一律只产草案，确认后才真正执行**，群邀请只能拟「接受/拒绝」草案；还能查团队的资源占用并拟「登记 / 结束」草案、查看团队标签并拟「新建 / 改名换色 / 删除」与「给任务贴/撕标签」草案（标签增删改仅团队 admin，结束占用限本人或 admin）；个人上下文可手填、也可让助手拟草案后确认，单人 ≤50 条、单条 ≤1000 字，每条可标「项目可见」（进项目助手，队友可见）或「仅自己」
- **AI 项目助手（`scope="project"`，仅 API）**：项目页原先的共享助手卡片已撤；`/api/chat` 仍保留项目共享会话（全员共用一条，能看到成员「项目可见」的个人上下文），供外部客户端调用。对话式拆解任务，两段式确认后落库（读工具 + 多类写工具草案）；一句话里的多个独立动作在同一轮全部拟成卡片，依赖新 id 的动作在确认落库后点「继续处理后续动作」补做；支持子任务的新增/修改/删除与任务附件管理（查看、删除）
- **助手记得上文**：每轮把会话里最近 N 条聊天记录一并交给模型，于是能接着上一轮往下说（「再改一下」「那个项目」都认）；N 由用户自设（0–50，默认 10，一问一答算 2 条），在「AI 设置」页改（原助手卡右上角的设置已并入），右侧面板与项目 scope 同按这一个数来
- **资源占用登记**：团队共享资源（服务器/算力等）的占用登记与时长汇总，纯登记无审批
- **Personal API Token**：生成/撤销令牌，供外部程序以本人身份写入
- **Agent 写入 API**：Claude Code 等携令牌直接添加任务、填写完成情况、登记资源占用
- **时间线甘特**：项目内任务按里程碑分组的甘特视图，逾期标红、今日竖线
- **时区**：站内所有时间按用户自选的时区显示，「今天/逾期/本周」也按它算——默认中国时间（`Asia/Shanghai`），可在「AI 设置」里改，或选「跟随浏览器」
- **自定义工作台**：整个工作台卡片化（看板、统计、最新记录、我的项目、团队、消息、便签、时钟、倒计时等），编辑模式支持拖动、缩放、网格吸附、增删卡片与恢复默认，每个用户独立保存在 `users.dashboard_layout`；窄屏（或助手抽屉把正文挤窄）自动切换为只读堆叠

## 技术栈

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · PostgreSQL 16 + Drizzle ORM · Auth.js v5 (JWT) · Vercel AI SDK v5 (DeepSeek / openai-compatible) · Tailwind CSS v4 · Vitest

## 本地启动

```bash
docker compose up -d          # 启动 Postgres（首次自动建 dev 与 test 两库）
cp .env.example .env          # 填入 AUTH_SECRET（openssl rand -base64 32）与 DATABASE_URL
npm install
npm run db:push               # 推送 schema 到开发库
npm run db:push:test          # 推送 schema 到测试库
npm run dev
```

> `scripts/init-test-db.sql` 仅在 Postgres 数据卷**首次初始化**时执行。若改过 init 脚本或测试库缺失，需 `docker compose down -v` 重建数据卷再 `up`（会清空本地开发数据）。
> 本机若用 colima 提供 Docker：先 `colima start`。

测试：`npm test`

## 协作开发规范

`master` 受分支保护：**不能直推**，改动一律走 Pull Request，须 **CI 全绿 + 至少 1 人 approve** 方可合并（管理员亦应走此流程，仅应急可绕过）。

### 日常流程

```bash
git pull --rebase origin master   # 1. 开工前先同步最新
git checkout -b feat/任务名        # 2. 开自己的分支
# 3. 小步提交；推送前本地先绿：
npm run lint
npm test
git push -u origin feat/任务名    # 4. 推分支，到 GitHub 开 PR
```

### 约定

| 事项 | 约定 |
|---|---|
| 分支命名 | `feat/xxx`（功能）`fix/xxx`（修复）`docs/xxx`（文档） |
| `homepage` 分支 | 团队主页专用（GitHub Pages：https://hch-Jack.github.io/agilecampus/ ），与 master 完全隔离；改主页切该分支直推，勿在 master 上修改主页文件 |
| 提交信息 | 沿用 `类型: 简述`（feat / fix / docs / chore / ci），缘由写清 |
| 合并方式 | PR 用 **Squash merge**，一个 PR 压成一条提交，master 历史干净 |
| 冲突 | `git pull --rebase origin master` 本地解决，解完**重跑 lint + 测试**再推；禁对共享分支 `--force` |
| 环境与密钥 | `.env` / `.env.test` 各自本地一份，**绝不提交**；密钥（AUTH_SECRET、令牌等）不进代码与聊天记录 |
| 认领任务 | 动手前在 Issues 或项目看板认领/登记，避免两人同时改同一模块 |

### PR 评审与合并（网页操作）

1. **等 CI 全绿**：PR 页自动跑 lint、测试、构建，三个检查全部打勾（约 1-2 分钟）；有红叉禁止合并
2. **队友评审**（PR 作者不能批准自己的 PR）：
   - 打开 PR 链接，点「**Files changed**」查看改动内容
   - 点右上角绿色「**Review changes**」→ 选「**Approve**」→ 点「**Submit review**」
3. **合并**：
   - 回到「Conversation」标签，点「**Merge pull request**」旁边的小三角 → 选「**Squash and merge**」→ 点「**Confirm squash and merge**」
   - 合并完成后点「**Delete branch**」删除功能分支
4. **本地收尾**：`git pull --rebase origin master` 同步最新，`git branch -d 功能分支名` 删掉本地分支

> 管理员紧急情况可在网页直接 Merge（保护规则不强制管理员），常规一律走评审流程。

### CI

`.github/workflows/ci.yml`：每次 PR 或推 master 自动跑 **lint → 测试 → 构建**（测试起 Postgres 16 容器并自动建测试库，与本地同版），任一失败禁止合并。先本地 `npm run lint` + `npm test` 全绿再推，CI 只是最后一道门。

## 生产部署（一键全栈）

`docker-compose.prod.yml` 编排 `db` + `migrate`（自动建表）+ `app` 三服务，同网络起，无需手动推 schema。

```bash
cp .env.example .env
# 填齐生产密钥：
#   AUTH_SECRET=$(openssl rand -base64 32)
#   POSTGRES_PASSWORD=<强密码>          # db 密码，compose 变量插值单一来源
#   AGILECAMPUS_URL=https://<对外域名>   # 飞书 OAuth 回调据此拼跳转
#   DEEPSEEK_API_KEY / FEISHU_APP_ID / FEISHU_APP_SECRET=<真值>
#   FEISHU_REDIRECT_URI=https://<对外域名>/api/auth/feishu/callback
#   CRON_SECRET=$(openssl rand -hex 32)
nano .env

docker compose -f docker-compose.prod.yml up -d --build
```

`migrate` 服务待 `db` healthcheck 通过后跑 `db:push` 建表，成功退出后 `app` 方启动。`app` 内 `DATABASE_URL` 由 compose 指向服务名 `db`，覆盖 `.env` 的 localhost 值（无需改 `.env`）。

**定时提醒**（临期/逾期私信）须由宿主 crontab 每日打一次 cron 端点：

```bash
( crontab -l 2>/dev/null; \
  echo '0 9 * * * curl -fsS -X POST http://localhost:3000/api/cron/reminders -H "Authorization: Bearer <CRON_SECRET>" >/dev/null 2>&1' \
) | crontab -
```

> NAS 部署：本机 `rsync -az --delete --exclude node_modules --exclude .next --exclude .git ./ root@<nas>:/volume1/docker/agilecampus/`，再 ssh 上去于该目录执行上述 `up` 命令。
> 飞书应用后台须将 `FEISHU_REDIRECT_URI` 加入重定向白名单，绑定方能成。

### 时区列的读写口径（无时区 `timestamp`）

站内所有时间列都是 `timestamp without time zone` —— 存的是**钟面读数**，本身不带偏移，
光看数据无从知道那串 `18:19` 属于哪个时区。PG 自己写时间（`now()` / `defaultNow()`）时落的是
**库会话时区**的钟面，所以应用的读写也都按会话时区换算：`src/db/schema.ts` 的
`dbTimestamp` / `dbTimestampNow`（连上库时用 `SHOW timezone` 探明一次，见 `src/db/index.ts`）。

这样**库会话时区配成什么都不错**：`docker-compose.prod.yml` 与 `Dockerfile` 都不设 `TZ`，
两个容器同为 UTC，照旧；运维把库配在 +08 也一样对。

- **千万别对已运行过的库就地改时区**：老行按旧时区落盘、新行按新时区落盘，
  同一列里混进两种含义 —— 那是改坏数据，不是修 bug。
- 新增时间列**必须走 `dbTimestamp` / `dbTimestampNow`**，别直接用 drizzle 自带的 `timestamp()`：
  后者把无时区值一律当 UTC 读（`new Date(值 + "+0000")`），库会话不是 UTC 时整站差一个偏移。
  物理类型两者完全相同（都是 `timestamp`），故 `db:push` 不会产生 ALTER；
  `tests/db-timestamp.test.ts` 把这两条都围住了。
- `src/lib/time.ts` 是纯函数层（`tests/time.test.ts` 覆盖跨时区/夏令时/日界）。
  注意 `node:22-alpine` 官方镜像是 full-ICU；若产物退化成 small-ICU，时区换算会**静默**退化为 UTC。

### 工作台自定义（`users.dashboard_layout`）

工作台布局存 `users.dashboard_layout`（jsonb，可空）：`NULL` = 从未自定义（默认布局），
`{ v: 1, items: [{ id, x, y, w, h, config? }] }` = 用户布局，`items: []` = 主动把卡片删空。
列刻意不标类型（照 `messages.tool_calls` 先例），读写在 `src/lib/dashboard-layout-store.ts` 收口，
进出都过一次 `normalizeLayoutDoc`：坏数据回落默认、未知/重复 id 丢弃、尺寸与坐标夹取、
重叠卡片向下推开（不自动回填空隙，允许留白）。

- **纯函数引擎** `src/lib/dashboard-layout.ts` 不碰 IO、不引 zod，客户端拖拽预览与服务端落库共用同一套规则；
  zod 只在 server action `src/app/(app)/dashboard/actions.ts` 校验信封，身份只取 session，不接受客户端 userId。
- **拖拽语义**：拖到哪格占哪格，重叠的卡片向下让位；位置按放下时算，可以自由留白（删卡也不牵动其他卡片）。
  缩放不低于目录里的最小尺寸、不超出 12 列。拖动时被拖的卡钉在起点、用 `transform` 连续跟手
  （网格吸附只决定其他卡片怎么让位），缩放时宽高按指针连续变化；松手后由 FLIP 过渡（180ms）
  滑入吸附位，其他卡片被挤开、归位同样走这条过渡。卡片内的滚动区域隐藏滚动条（仍可滚动）。
- **统计两种表示互斥**：「任务概览」（四合一）与四张单项统计卡只能存在一组；添加一种会自动移除另一种。
- **保存不 revalidate**：编辑态下整页数据回流会用服务端旧数据覆盖本地未保存布局。请求串行 + latest-wins，
  飞行期间的新改动合并成待发；失败保留本地布局，工具栏可重试。
- **窄屏只读**：视口 `<1024px` 或正文容器 `<720px`（打开右侧助手抽屉）时按 `y,x` 堆叠，
  编辑入口隐藏，编辑中也会自动退出。卡片数据由服务端一次性加载，加卡不需要再请求。

### 助手会话的两种 scope（`/api/chat`）

`conversations` 一表两态，由 `CHECK` 钉住形状：`kind='project'` ⇒ `project_id` 非空且 `owner_id` 为空（全员共享）；
`kind='personal'` ⇒ 反之（严格按人隔离）。`/api/chat` 与 `/api/chat/commit` 的 `scope` 缺省为 `project`（老客户端不受影响）。
`personal` 时 `projectId` 可选，含义是**焦点项目**：它只影响这一轮——提示词末尾多一段「当前项目」快照，
工具面多放出 `list_project_activity` / `list_comments` / `list_chat_history` / `create_subtask` /
`delete_subtask` / `delete_attachment` 六件（个人基础工具 36 件 → 42 件）——**不改变会话归属**，
落库仍是本人的个人会话（请求体可带 `conversationId` 指定；缺省落到最近一条，没有才新建）；
权限在编排入口先按 `getProjectForUser` 校（无权 403，且不会先落一条空会话）。
不带 `projectId` 时没有隐含项目，涉及项目的工具必须由模型在草案里显式给 `projectId`，
**落库时逐条重校 `getProjectForUser`**（越权即 403，属预期而非 bug）。
个人回合的响应会附 `options`（按草案里的 projectId 给成员/里程碑下拉，无权项目跳过），供草案卡渲染选择项。

- **`actorId` 只来自 session**：两处路由的请求体里没有身份字段，草案里夹带 `userId` 在 lib 层被丢弃。
- 个人会话**每人可以有多条**：`owner_id` 上是普通索引（`conversations_owner_idx`），不再是唯一约束。
  并发安全改由 `pg_advisory_xact_lock(hashtextextended(actorId, 0))` 保证（`resolvePersonalConversation` /
  `startPersonalConversation` / 清空记录都在同一把锁下）——**不要**为了防并发再加回唯一索引。
- `conversations.last_message_at`（可空）记录最近一次落消息的时间，会话列表按
  `coalesce(last_message_at, created_at) DESC` 排序；老数据为空时回落到创建时间。
- `messages.turn_id`（可空）把同一轮的提问与回答绑在一起：删任意一条 = 删整轮。
  老数据没有 turn_id，删除时在 SQL 里按**原始** `created_at` 相等配对 —— 读出来的 `Date` 已被截到毫秒，
  绝不能拿它反查（见 `lib/time.ts` 的说明）。
- 个人会话 REST：`POST /api/chat/conversations`（新建/复用空会话）、
  `GET|PATCH|DELETE /api/chat/conversations/[id]`（取消息/改名/删除）、
  `DELETE /api/chat/messages/[id]`（成对删一轮）。全部只认 session 身份，别人的资源一律 404。
- 个人上下文存在 `personal_contexts`；`visibility='shared'` 的条目会进**项目助手**的快照，
  也会进右侧助手在项目页时的「当前项目」段（`shared` 是默认值：写之前请知道队友看得到，
  `private` 才只在本人快照里）。
- 快照对上下文有字符预算与降级链（任务明细 → 里程碑明细 → 上下文），改 `snapshot.ts` 时别打乱这个顺序。

### 右侧助手面板

- 入口是顶栏的「AI 助手」按钮（`src/components/assistant-shell.tsx`）：桌面端（≥1024px）把正文挤窄一列，
  移动端覆盖 + 遮罩；Escape、遮罩点击与面板右上角 × 都能收起。打开状态不跨刷新持久化。
- 面板**常驻挂载**，收起只是移出视口 + `inert`：`AgentChat` 的 `useState(initialMessages)` 只播种一次，
  开合与切换页面都不会重放或丢掉消息。切页时面板状态也保留。
- 面板必须是 `<header>` 的**兄弟节点**：顶栏带 `backdrop-blur`，会成为 `fixed` 后代的包含块，
  放进 header 里定位就错了。
- 焦点项目从 `pathname` 推（`src/lib/project-path.ts`，只认 `/projects/<uuid>`，大小写 uuid 都认）。
  焦点不是会话归属：切换项目不会开新会话；草案卡的「继续处理后续动作」按**出卡时**那个项目续做
  （每条消息各自记着焦点）。
- 面板顶部是会话列表（`src/components/assistant-conversations.tsx`）：切换、新建、行内改名、删除。
  列表走**正常文档流**（抽屉带 `transform`、宇宙主题还有 `backdrop-filter`，absolute/fixed 弹层会被裁切）。
  「新对话」会复用最近一条空会话，连点不会堆空行。
- 「上次看的是哪条」记在 cookie `ac_assistant_conversation`（客户端写、layout 读），服务端校验归属后才用；
  没有或无效就回落到最近一条。整页刷新后仍停在原会话。
- `AgentChat` 用 `viewKey` 重新播种：只在**显式**切换/新建/删除当前会话/重置时递增。发送时后端替新用户
  懒建会话**不递增** —— 否则刚发出去的消息连同输入框会一起被 remount 掉。
- 每条消息旁的删除按钮删掉**同一轮**的提问与回答（`messages.turn_id`；老数据按原始 `created_at` 配对）。
  删到空会话后 `last_message_at` 归 NULL，列表退回按创建时间排序。删除**不撤销**已确认落库的改动。
- **助手正文按 Markdown 渲染**（`src/components/markdown.tsx`）：react-markdown + GFM，支持粗体、列表、
  任务清单、代码块与表格；默认**不渲染原始 HTML**，链接一律新窗口打开，远端图片只给可点开的链接；
  表格与代码块在窄面板里横向滚动。用户自己的提问仍按纯文本显示，免得 `*`、`#` 被吃掉。
  单个换行由 remark-breaks 转成 `<br>`，模型整段平铺时不会粘成一行。
- **「继续处理后续动作」不展示提示词**：发出去的是给模型看的自包含提示词（原请求复述 + 续做规矩），
  面板里只显示一行「继续上一轮请求」。识别靠 `CONTINUATION_PREFIX` 开头标记，刷新、切会话后同样生效
  （不给消息表加字段）；再续一次时从提示词里取回最初那句人话，不会把提示词套娃进「原请求」。
- 每条会话一次取最近 200 条消息（`listPersonalConversationMessages`），列表最多 100 条 —— 都不做分页/「加载更早」。
- 助手设置（记忆条数 + 个人上下文 + **删除全部聊天记录**）在「AI 设置」页（`/settings`），面板标题行的「设置」直达。
  重置只删本人的 personal 会话（项目共享会话不动）；面板靠 `window` 事件 `ac:assistant-reset` 立即清空。

### 助手的页面跳转（`open_page`）

用户说「打开工作台」「跳到赤壁演习的关系图」「带我看看东吴实验室的资源占用」时，助手用 `open_page`
替他把右侧面板所在的页面换过去 —— 它**只换页面，不读数据**，也不产生确认卡（只读、立即生效）。

- **目标是白名单枚举**（`NAV_TARGETS`）：`dashboard` / `projects` / `teams` / `messages` / `settings`，
  项目四页（`project` / `project_graph` / `project_flow` / `project_timeline`），
  `task`，团队四页（`team_members` / `team_projects` / `team_resources` / `team_labels`）。
  **路径由服务端拼**（`src/lib/agent/navigation.ts`），模型只报目标与 id，不能自由发挥 URL。
- **id 与权限当场校验**：项目页走 `getProjectForUser`、团队页走 `getTeamForMember`、任务页走
  `getTaskDetail`（按任务实际所属项目）；无权一律 403，页面不会被打开。缺 id 报可操作的错，
  提示先 `list_tasks` / `get_task_detail` 取回。
- **返回形态**：工具返回 `{ __navigate: true, label, href }`；编排器把各步的跳转意图按 `href`
  去重后随响应下发 `navigations`。面板**只跳最后一个**（连开两页没有意义），并在该条回答下留
  「打开…」链接，方便回头再点。
- 面板挂在 `(app)/layout.tsx` 里、跨路由不卸载，所以跳转不会丢失当前对话或未确认的草案卡。
- 工具只在个人 scope 出现：项目助手没有「换页」的语义。

### 助手的建团与入团

- `create_team({ name })`：拟「创建团队」草案，确认后经 `createTeam` 落库，建团者自动成为 admin。
- `join_team({ inviteCode })`：拟「加入团队」草案。**邀请码只能来自用户这句话**（快照里没有邀请码，
  提示词也禁止猜测）；拟稿时先按码查出团队名，卡片显示「加入『某某团队』」，码无效或已在该团队中当场报错。
  落库那一刻 `joinTeam` 会再校一次（拟稿到确认之间码可能失效、人也可能已被拉进团）。
- 两者只进 `COMMIT_TOOL_NAMES`，不进 `WRITE_TOOL_NAMES`：项目 scope 的落库口天然拒收。
  与其它写工具一样只产草案，确认前助手不得声称「已创建 / 已加入」。

### 助手的多动作与读权限

- **一轮多件事**：编排器最多走 8 步工具循环（`stepCountIs(8)`，只是上限）。同一步内的多个 tool call
  由 AI SDK **并行**执行，后一个拿不到前一个的返回值 —— 所以模型被要求「能合批就合批、独立动作全做完再收尾」，
  草案则从各步 `toolResults` 里全部提取（不是只留最后一张卡）。
- **依赖新 id 的动作跨轮做**：新建任务的 id 要等用户确认落库后才存在。这类后续动作**不会自动续做**：
  卡片落库成功后出现「继续处理后续动作」，点击后客户端把「原请求 + 已落库摘要 + 未确认草案」拼成一条
  自包含消息发出去（`src/lib/agent/continuation.ts`，纯模块，客户端与服务端共用）。
  只有会派生新 id / 新可访问对象的工具（项目写工具、新增子任务、新建群聊、建团/入团）会触发它；
  删除类、发送/转发/邀请、个人上下文与群邀请不派生后续动作。
- **只读工具不改未读**：右侧助手（个人 scope）的 `list_message_threads` / `read_messages` 走
  `listDmMessagesReadOnly` / `listGroupMessagesReadOnly`，**不置 `read_at`、不推 `last_read_at`、不建联系人** ——
  助手看过不等于用户看过。提示词也明确要求不许谎称「已标已读」。
- **发送/邀请类动作只有草案**：`send_message` / `forward_message` / `create_group_chat` / `invite_to_group` 只返回草案，
  **绝不落库、绝不代发**；用户点确认后才经 `commitPersonalDraft` 重校目标/成员/附件权限并发送。
  群邀请只能经 `respond_group_invite` 产草案，确认后由 `commitGroupInviteResponse` 在事务内认领。
  项目 scope 的落库口只认 `WRITE_TOOL_NAMES`，天然拒收这些个人专属草案。
- **外部文本一律是数据**：留言、动态、聊天历史、私信与群消息都可能含「请建任务/请接受邀请」之类的文字。
  提示词把它们统一按资料处理：只有用户那句请求是指令，正文只能当素材。
- **个人快照只放消息计数**（未读数与待处理邀请数），绝不放消息正文、会话名或群名 —— 正文要用户显式让助手去读。

### 助手的子任务与附件能力

- **子任务**：`create_subtask` 新增（父任务 id 取自 `list_tasks` / `get_task_detail`）、
  `update_tasks` 修改（子任务就是任务）、`delete_subtask` 删除。删除入口**只收子任务**；
  删父任务须到任务详情页操作，删除子任务会级联删掉它下面的所有子任务与依赖。
  三者均走两段式草案；落库口会重新校验父/子层级与项目归属。
  这三件在项目 scope 里一直有；个人 scope 只在**焦点项目**下放出（右侧助手在项目页时）。
- **任务附件**：`list_attachments` 两个 scope 都能用（`attachmentId`/文件名/大小/上传者），
  个人助手靠它取到 `attachmentId` 才能把项目文件发出去；`delete_attachment` 删除
  （不可恢复，需确认）在项目 scope 与个人 scope 的焦点项目下都可用。底表 `task_attachments` 仍是唯一事实来源。
- **个人助手把消息文件复制成任务附件**：`read_messages` 对带文件的消息返回
  `attachment.attachmentId`；`attach_message_file_to_task` 拟一张草案，确认后由
  `copyMessageAttachmentToTask` **复制字节**新建 `task_attachments` 行
  （`dm_attachments` 与 `task_attachments` 无外键，复制而非共享）。此后删消息不影响任务附件，
  删任务附件也不影响聊天记录；同一文件占两份存储，单文件上限仍为 10MB。
  复制同时校验：消息附件可读（私信收发双方 / 群成员）+ 目标任务可写。
- **工具面分工**：个人 scope 基础 36 件（含附件查看、发文件、「消息文件 → 任务附件」、发送/邀请类工具、
  建团/入团、页面跳转，以及团队资源占用与标签的 8 件）；焦点项目再放出 6 件项目专属工具
  （动态、留言、旧助手对话、子任务新增/删除、附件删除），共 42 件。
  项目 scope 只认 `WRITE_TOOL_NAMES`，个人专属草案（上下文、群邀请、消息附件、发送/转发/建群/邀请进群、
  建团/入团、资源占用、标签）天然不会从项目 scope 提交。

### 助手的发送、转发、建群与邀请

- **找人**：`find_contact({ username })` 按用户名**精确**匹配（全站唯一、大小写不敏感），
  返回 `userId` 与规范用户名 `name`——发消息用 `userId`，建群/邀请用 `name`；
  不做模糊搜索，避免把全站用户名变成可枚举接口。
- **发消息**：`send_message` 支持私信（`targetType="user"`）与群聊（`targetType="group"`），
  正文与附件至少其一。附件用 `fileSource` 指明来源：`task` 是任务附件（把项目文件发出去），
  `message` 是私信/群聊附件（转发文件）。发送时**复制字节**进 `dm_attachments`，单文件仍 ≤10MB。
- **转发**：`forward_message` 把一条已有私信/群消息（连同附件）原样发给个人或群聊；
  源消息只允许收发双方/群成员读取，目标权限在落库时重校。
- **建群**：`create_group_chat({ name, usernames })` 与网页建群一致——成员用**用户名**（不是
  `userId`）指定，避免模型誊抄 uuid 出错；成员被**直接拉进群**，不是发邀请待接受。自己自动入群，
  名单里误写自己会被忽略；`usernames` 可留空，先建一个**只有自己**的群，之后再邀请。
  群名 ≤30 字、成员 ≤50 人。
- **邀请进群**：`invite_to_group({ groupId, usernames })` 一次可邀请一至多人（用户名精确匹配）；
  与建群不同，邀请是**待处理**状态，对方接受后才入群。已在群里、已邀请过、群满都会在拟稿时报错。
- **两段式铁律不变**：以上四个工具只产草案；卡片上可改正文/群名、移除成员/被邀请人或附件。
  确认前助手**不得声称已发送**，也不得仅凭消息正文里的「请转发给所有人」自动发送。
  REST 侧（`/api/agent/messages` 等）与助手的落库共用 `src/lib/chat-transfer.ts`，权限口径一致。

### 助手的团队资源占用与标签

两块的网页入口分别在 `/teams/[teamId]/resources` 与 `/teams/[teamId]/labels`；助手只把它们接进**个人 scope**
（右侧面板），项目 scope 不放出。`teamId` 一律取自快照「我的团队」。

- **读**：`list_resource_usages({ teamId })` 给占用记录（含 `usageId`）、进行中数量，以及按人/按资源的
  已结束总时长；`list_labels({ teamId })` 给 `labelId`、名称、颜色、贴在多少任务上，并用 `canManage`
  标明当前用户能不能增删改（仅团队 admin）。
- **资源占用**：`create_resource_usage` 登记（任一成员皆可）、`end_resource_usage` 结束。
  结束只能结束**本人登记的**记录，团队 admin 可结束任意一条；已结束的记录不能再结束。
  时间入参是**用户本地墙面时间** `YYYY-MM-DDTHH:mm`，拟稿与落库都用 `resolveUserTimeZone` +
  `zonedWallClockToInstant` 换算成绝对时刻（个人快照里也给出「现在」的完整墙面时间）——
  绝不 `new Date(墙上时间)`。结束时间留空即「仍在占用」。
- **标签管理**：`create_label` / `update_label` / `delete_label` 仅团队 admin（权限在 lib 层再校）；
  名称 ≤20 字、同团队不区分大小写去重。删除会从所有任务上撕下该标签，卡片会显示会影响多少任务。
- **给任务贴/撕标签**：`edit_task_labels({ taskId, add, remove })` 用**增量**语义，卡片勾选的是
  **最终全量集合**；落库走 `setTaskLabels` 的全量替换，并由 lib 重校任务写权限与标签的团队归属。
  跨团队标签、添加已有的、移除没有的、最终没变化都会当场报错。
- **两段式不变**：六件写工具只产草案；确认前助手不得声称已登记/已结束/已建/已删/已贴。

### 助手的「上文」（`users.ai_history_limit`）

每轮的请求体是「最近 N 条聊天记录 + 本轮这句话」（`conversation.ts` 的 `recentMessagesForModel`），
N 是**用户级**偏好 `users.ai_history_limit`（0 = 不看历史，默认 10，上限 50）——
**两个 scope 共用同一个数**，右侧面板与项目 scope 读的是同一条。常量与钳制在
`src/lib/agent/history-limit.ts`（纯模块，界面要引它显示上下限，**别把 `db` 拖进去**），
存取在 `src/lib/agent/memory.ts`。

- 取的是**最近** N 条：先按 `created_at` 倒序取再反转。正序取 N 条那是「最早的头几条」。
- 同一轮的问与答是**同一条 INSERT** 落的，`now()` 在一条语句里取值相同，`created_at` 逐字相等 ——
  故排序列里必须补一个「答在下、问在上」，否则同一轮的两句谁先谁后全看 PG 心情。
- 反转后开头若是「答」就丢掉：上下文不能以答话打头（有些模型也不接受）。
- 单条消息的长度**不做截断**（条数上限就是唯一的闸）—— 往输入框里贴长文会直接进提示词。

## 主要路由

| 路由 | 说明 |
|---|---|
| `/teams` | 我的团队（创建/加入/解散，解散仅 admin 且不可撤销） |
| `/teams/[teamId]/members` | 成员管理（admin 移除非管理员成员；任何人可退出团队，末位 admin 退出须先指定继任者。成员身份由注册时选定的身份决定，加入团队即按此定角色，网页上不提供改身份入口） |
| `/teams/[teamId]/projects` | 项目列表（admin 创建） |
| `/teams/[teamId]/resources` | 资源占用登记 + 时长统计 |
| `/teams/[teamId]/labels` | 团队标签管理（admin 增删改，成员只读） |
| `/dashboard` | 工作台：可自定义卡片布局（拖动/缩放/增删，按用户保存）；任务看板按项目筛选、拖拽流转 |
| `/projects` | 所有项目总览（跨团队聚合 + 任务统计） |
| `/projects/[projectId]` | 项目详情：里程碑 + 看板 + 任务（右侧助手在此自动带入本项目） |
| `/projects/[projectId]/timeline` | 项目时间线甘特 |
| `/messages` | 消息中心（QQ 式消息栏：搜用户名加会话，点对点收发消息与文件） |
| `/welcome` | 欢迎页（整屏时钟，登录后的落地页；左上角徽标点击即回此处） |
| `/settings` | AI 设置：助手记忆条数 + 个人上下文 + 聊天记录重置 + 时区选择 + 飞书绑定 + 个人访问令牌（生成/撤销），顶栏「AI 设置」直达 |
| `/settings/tokens` | 旧地址，一跳 `/settings`（令牌页已并入 AI 设置） |

---

## Agent 写入 API

供 Claude Code 等浏览器之外的程序，以用户身份写入 AgileCampus。

### 认证

所有 `/api/agent/*` 端点用 **Personal API Token** 认证（区别于浏览器 session）：

```
Authorization: Bearer <token>
```

在网页顶栏「AI 设置」页生成，明文只显示一次；库中仅存 sha256 hash。令牌权限等同本人：只能操作有权限的团队/项目，越权返回 `403`。约定两个环境变量：

- `AGILECAMPUS_URL` — 站点地址，如 `http://localhost:3000`
- `AGILECAMPUS_TOKEN` — 令牌明文

### `POST /api/agent/tasks` — 新建任务

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

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/tasks" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<uuid>","title":"撰写调研问卷","startDate":"2026-07-01","dueDate":"2026-07-08","priority":"high"}'
# → { "id": "...", "title": "撰写调研问卷", "status": "todo" }
```

### `POST /api/agent/tasks/complete` — 填写完成情况

将任务标记为 `done` 并附完成说明。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskId` | uuid | 是 | 目标任务 |
| `completionNote` | string | 是 | 完成说明 |

```bash
curl -X POST "$AGILECAMPUS_URL/api/agent/tasks/complete" \
  -H "Authorization: Bearer $AGILECAMPUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"<uuid>","completionNote":"已跑通全部演武"}'
# → { "id": "...", "status": "done" }
```

### `POST /api/agent/resource-usage` — 登记资源占用

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
  -d '{"teamId":"<uuid>","resourceName":"GPU-01","purpose":"训练模型","startTime":"2026-07-22T14:00:00Z"}'
# → { "id": "...", "resourceName": "GPU-01", "active": true }
```

### 响应与错误

| 状态 | 含义 |
|---|---|
| `200` | 成功，返回创建/更新后的精简对象（含 `id`） |
| `400` | 请求格式无效（缺字段、类型错、时间非法） |
| `401` | 令牌缺失、畸形、伪造或已撤销 |
| `403` | 越权——令牌主人对目标项目/团队无权限 |
| `500` | 服务器错误，可重试 |

### 安全说明

- 令牌库中只存 sha256 hash，明文只在生成时返回一次，泄露即在设置页撤销。
- 外部写入一律不被信任：`token → userId → lib 权限校验`，越权由业务层拒绝。

### Claude Code 集成

项目内置 `.claude/skills/agilecampus/` skill，封装上述端点调用——配置好 `AGILECAMPUS_TOKEN` 与 `AGILECAMPUS_URL` 后，即可在 Claude Code 里用自然语言「给项目 X 加任务 Y」「把任务 Z 标记完成」「登记我占用了 GPU-01」。完整契约另见 [`docs/agent-api.md`](docs/agent-api.md)。

---

## 文档

- 设计与作战图：`docs/superpowers/`
- Agent 写入 API：`docs/agent-api.md`
- 技术债备案：`docs/BACKLOG.md`
