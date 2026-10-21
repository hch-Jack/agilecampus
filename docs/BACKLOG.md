# 技术债备案（作战图一审查沉淀）

内部试用可接受、市场化/正式上线前须重审的取舍：

## 安全/认证
- JWT 会话无显式失效机制，默认 30 天 maxAge——改密码后旧 token 仍有效；正式上线前设短 maxAge 或引入会话版本号
- authorize 对不存在用户不跑 bcrypt（时序侧信道可枚举邮箱）——如需弭平，对不存在用户跑固定 hash 的 compare 占位
- ~~最后一名 admin 可被降级/自降导致团队无管理员——lib 层补"末位 admin 不可降级"不变量~~ **[已偿·图九]** `assertKeepsAnAdmin` 挡住降级，`leaveTeam` 的继任者要求挡住退出，二者共用 `teams` 行锁（`FOR UPDATE`）在并发下成立
- 成员管理页对全体成员展示所有人邮箱——确认隐私合规或限 admin 可见

## 产品
- 邀请码 nanoid(10) 混大小写含 -/_，口头/板书传播不友好——可换大写字母+数字自定义字母表（去 0/O/1/I/L）
- 邀请码对全体成员明文展示——考虑仅 admin 可见
- createTeam 邀请码唯一键碰撞（概率 64^-10）无重试兜底

## 工程
- docker-compose 硬编码凭证与 .env 双源无关联机制——改 env_file/变量插值统一来源
- docker-compose 无 healthcheck——引入 depends_on 服务前补
- ~~团队列表查询直写在 page.tsx——再有同类需求时上提 lib 层 listMyTeams~~ **[已偿·图九]** 上提 `listMyTeams`，并顺带带上「解散会删掉多少东西」的内容计数（4 条分组聚合一次覆盖全部团队）
- bcryptjs 自带类型声明，@types/bcryptjs 冗余可移除
- SALT_ROUNDS=10 为下限，可评估升 12

## 图二（骨架）简化备案
- 无项目级成员表：团队成员即可见全部团队项目（"参与的项目"从宽）
- 看板列内手动排序未做（sort_order 已建，拖拽仅改状态）
- teacher 反馈/评论功能后置（设计文档原定 MVP 后）
- 里程碑无编辑/关闭入口（仅创建与展示，状态字段已建）
- 项目无编辑/归档入口（status 字段已建）
- updateTask/deleteTask "任务不存在"先于权限返回，对非成员泄露 uuid 存在性（uuid 不可枚举，风险极低）

## 图三上（对话地基）简化备案
- 对话采请求-响应式（generateText 非流式），真流式（useChat + toUIMessageStreamResponse）后置——无密钥时流式无从离线验证
- 每项目一活跃会话（getOrCreateConversation 取最近一条），未做多会话/会话列表
- tool role 消息未独立成行：工具轨迹并入 assistant 消息的 toolCalls jsonb
- DeepSeek 真实调用未演武（离线打通策），密钥齐备后须补真实一轮问答验收
- 快照上限固定 2000 字符、超限整体降级为统计头，未做分段精细裁剪
- 工具执行走底层 lib 各自的权限校验，与编排入口 getProjectForUser 构成轻微重复查询（复用现成 lib，未优化）

## 依赖版本教训（图三上 Task 6 沉淀）
- **AI SDK provider spec 版本须对齐**：`ai@5` 依赖 `@ai-sdk/provider@2`（LanguageModelV2），`generateText` 按 `specificationVersion === "v2"` 分派；`@ai-sdk/openai-compatible@3` 却依赖 provider@4（V4），既过不了 tsc，生产 getModel 亦运行时不匹配。正解锁 `@ai-sdk/openai-compatible@^1.0.46`（依赖 provider@2），使全树 provider dedupe 至单一 2.0.3。日后若升 `ai` 至 v6/provider V4，openai-compatible 须同步回 @3。
- `ai/test` 的 `MockLanguageModelV2` 数组形式 `doGenerate: [...]` 在 5.0.218 下按 `doGenerateCalls.length`（push 后）取值，等效 1-indexed 跳过 [0]；多轮 replay 须用函数游标形式 `doGenerate: async () => script[cursor++]`。
- `ai/test` 静态 import `msw`（provider-utils 的声明依赖但未随装），须显式补 `msw` devDependency 方可离线用 mock。

## 图三下（四写兵器）简化备案
- plan_sprint 免版本校验（草案仅 taskIds 无逐任务 updatedAt）——批量归里程碑+设截止日，低冲突，MVP 可接受
- update_tasks 乐观锁比对 updatedAt.toISOString()；同一毫秒两写理论上仍可能漏检，概率极低
- update_tasks 同批次若含同一任务两条变更，versionOf 为循环前快照，第二条仍可能通过（边缘场景，MVP 不处理）
- 草案不入库持久化：仅随 assistant 消息 toolCalls 留痕 + 前端态；页面刷新后未落库的草案卡片消失（需重新对话）
- 确认卡片可编辑聚焦核心字段：update_tasks 卡仅展示 patch（不可逐字段改）
- DeepSeek 真实「拆任务→确认→落库」演武待密钥
- ~~**批量落库非事务**（总审沉淀）：commitDraft 的 decompose/update/plan_sprint 循环无 db.transaction，中途第 k 项抛错则前 k 项已落库、请求返错、用户重试致重复；市场化前须事务化（须图二 createTask/updateTask 接受 tx 参数）~~ **[已偿·图七]** createTask/updateTask 收 tx，三分支裹 db.transaction，通知事务提交后补发
- update_tasks 中不属本项目的 taskId 被误报为"版本冲突/他人改动"（实为无效 id）——纯提示文案，无安全影响

## 图四（任务增强+总览）简化备案
- ~~后置任务仅防直接成环（A↔B），未做间接环（A→B→C→A）检测~~ **[已偿]** `setTaskSuccessors` 沿反向边求祖先集，直接/间接环一律拒绝（见 `tests/task-detail.test.ts`）
- 完成情况(completionNote)仅编辑态填写，未做「拖入已完成时弹窗提示补充」的引导交互
- 跨项目总览为列表+任务统计，未含管理员整体看板泳道/甘特图（留后续「图五·管理视图」）
- listMyProjects 对 admin/teacher/student 一视同仁（无项目级成员表，沿图二备案）
- 后置任务多选下拉在任务多时体验一般（原生 select multiple），未做更友好的选择器

## 图五（API Token + 资源占用 + CC 写入）简化备案
- token 作用域=该用户全部权限（MVP），未做限定项目的细粒度作用域（留后续）
- token 无过期机制，仅撤销即失效；未做自动过期/轮换
- verifyApiToken 每次校验命中即写 lastUsedAt（每请求一次写），未做节流/批量
- listApiTokens 含已撤销令牌供 UI 标注状态，撤销记录不清理会累积（无软删清理任务）
- 资源名自由填写，无预定义资源池/资源实体表——同名字符串即同一资源（大小写/空格敏感）
- 时长汇总仅计已结束占用；进行中占用不计入 byUser/byResource（避免 now 引入的不确定性）
- endResourceUsage 权限=登记者本人 or 团队 admin；teacher/其他成员不可结束他人占用
- /api/agent/* 无速率限制，防滥用（限流）后置
- resource-usage 端点时间用 z.coerce.date()，时区取决于调用方传入的 ISO 串；网页表单用 datetime-local（本地墙钟）
- ~~CC 仅「写入」（加任务/填完成/登记资源），未做「读」端点（查进度/列任务）——陛下所命~~ **[已偿·图八]** 补五道读端点：`GET /projects`、`GET /projects/{id}`、`GET /projects/{id}/tasks`、`GET /tasks/{id}`、`GET /tasks/{id}/subtasks`
- CC skill 需用户手动配置 AGILECAMPUS_TOKEN/AGILECAMPUS_URL 环境变量；skill 未自动发现 project/team 的 uuid（需用户提供或从地址栏取）
- 尚未攻取：C 实验时间线视图、E 飞书接入（须陛下先备飞书 AppID/Secret）

## 图六·C（实验时间线甘特）简化备案
- 任务加 startDate（可空 date）；时间线取 [startDate?, dueDate?]：仅一端有值时以该端为准，单日任务补 1 天宽度
- 甘特纯 server 端渲染 + CSS 百分比定位，无缩放/拖拽/横向滚动（长跨度项目条会很细）——只读查勘视图
- 时间范围强制纳入「今日」，全部任务在远期时图会被今日拉长（现实数据近期，可接受）
- 逾期判定=status≠done 且 dueDate<今日；未设 dueDate 的任务不判逾期
- 里程碑分组按 listProjectMilestones 顺序 + 末尾「无里程碑」；未排期任务单列徽章展示，不入甘特
- 时间线为项目级；跨项目/团队总甘特未做（留后续管理视图）
- startDate 未校验 ≤ dueDate（前端可倒填）；甘特对 start>end 做防御性纠正，但 lib 未强约束
- 时间线视图只读，未做在甘特上直接拖拽改期

## 图七（飞书接入）简化备案
- cron 端点无「当日已发」去重——逾期任务每日一提醒，靠外部调度每日一击天然节流；同日重跑会重复发
- 日报仅按 assignee 聚合；未指派的临期/逾期任务无人可提醒（不发）
- 完成通知仅发创建者一人；admin/teacher 全局视角后置
- 飞书消息用纯文本，未做交互卡片（含「查看任务」跳转按钮）——富卡片后置
- OAuth `state` 存 cookie 即可，未引入服务端 state 存储/一次性消费
- token 缓存为进程内存——多实例各自缓存（各自换取，飞书侧允许）；未做共享缓存
- 未做飞书事件订阅（用户在飞书内退订/停用应用的回调）——绑定后飞书号失效时发送失败仅记日志
- `scanAndNotifyDue` 全库扫描——任务量大时未分页/分批；当前规模可接受
- update_tasks 批量确认仅补发完成通知，未补发改派通知（改派走网页/CC 即时路径）
- 真机飞书 OAuth 绑定验收（Task 6）须备妥凭证亲验，离线不可代

## 图八（AI 修复 + 项目管理 API + 子任务）简化备案

### 本役沉淀（教训）
- **DeepSeek 番号已改制**：`deepseek-chat` 遭废弃，今只认 `deepseek-v4-pro` / `deepseek-v4-flash`，误用返 400 `invalid_request_error`。此即「对话失败，请重试」500 之真因（APICallError 非 AppError，落入通用分支）。现取 `DEEPSEEK_MODEL` 环境变量，缺省 `deepseek-v4-flash`。**日后模型番号务必置于配置，勿硬编码。**
- **快照缺 id 则写工具形同虚设**：旧快照只给成员名与里程碑标题，不给 uuid，模型遂无从填 `assigneeId`/`milestoneId`，指派与排期必空。今补 `id=` 于成员/里程碑/任务三段，并补「今天是 YYYY-MM-DD」——缺此则相对日期（「下周五」）必错。
- **模型会「演」草案而不调工具**：DeepSeek 曾口称「已拟好变更草案」而 `drafts` 实为空，界面一片空白。prompt 须显式声明「只有真正调用工具才会生成草案卡片，你写的文字不会变成草案」方止此弊。
- **模型过度盘问亦是缺陷**：仅告以「信息不足先问清楚」，模型对「帮我建个完成ai的任务」一味追问。须以实例立法（示以具体输入与应有动作）方肯动手。prompt 中一则范例胜过三条抽象规矩。

### 简化取舍
- 子任务仅一层语义（`parent_task_id` 自引用），API 只列**直接子级**不递归；深层树形与「展开全部子孙」后置
- **既有看板/甘特/统计视图未识子任务**——子任务作为普通任务平铺显示，父任务统计不含子任务汇总。UI 层级呈现留待陛下定夺
- `updateTask` 未开放改 `parentTaskId`（故无成环之虞，亦无须环检测）；如日后开放，须补环检测
- AI 写工具（`decompose_tasks`）未支持 `parentTaskId`——AI 拆出的任务一律为顶层
- `POST /api/agent/tasks`（body 传 projectId）与 `POST /api/agent/projects/{id}/tasks`（路径传）并存，功能重叠；保留旧约以免折损在用之 skill
- `create_milestone` 落库需 admin（沿 `createMilestone` 口径），student 拟出草案却点不动「确认落库」——提示文案未作角色预判
- `GET /projects/{id}/tasks` 之筛选在应用层做（取全量再 filter），未下推 SQL；当前规模可接受
- `getTaskDetail`/`listSubtasks` 沿旧口径，「任务不存在」先于权限返回（uuid 不可枚举，风险极低）
- 真实模型演武置于 `tests/agent-live.test.ts`，以 `describe.skipIf(!process.env.DEEPSEEK_API_KEY)` 自守——`.env.test` 无此变量，故 `npm test` 自动跳过、不耗额度。真打跑法：
  `export DEEPSEEK_API_KEY=sk-xxx && npx dotenv -e .env.test -- npx vitest run tests/agent-live.test.ts`
  （注：vitest 4 已无 `--include` 旗号，勿用）
- `tests/agent-drafts.test.ts` 在全量并行下偶发 5s 超时（单跑 852ms 即捷）——共享测试库之粮道拥塞，未调 `testTimeout`

## 图九（团队生命周期：解散/移除/退出）简化备案

### 本役沉淀（教训）
- **「只剩自己就解散」必须由页面显式要求，不能由服务端自行推断。** 页面渲染到提交之间可能有人刚好退出，把「还有别人」变成「只剩你一人」；此时若照解散办，用户就在一个**只写了「可凭邀请码重新加入」**的确认框上丢掉了整个团队。今以隐藏字段 `dissolveIfSole` 作确认令牌：没渲染过「退出并解散」确认框就不带它，服务端据此拒绝（拒绝是安全的，刷新即可看到真正的解散确认）。**凡「一次确认会销毁不可逆数据」的路径，都要核对确认框渲染时的事实与执行时的事实是否同一。**
- **跨行约束要锁对行，且锁必须是事务第一条语句。** 「本团队还有几名 admin」的对象是**计数**，锁 `team_members` 的行挡不住「两个人同时退出/同时降级」（锁的是不同的行）。锁 `teams` 单行才能让这两件事排队。晚于任何计数去加锁，那条计数读的就是加锁前的快照，锁白拿。**另注：Postgres 不允许对 `count(*)` 加 `FOR UPDATE`**，故锁裸行、计数另起查询。
- **实测取证胜过推理**：把 `lockTeam` 注释掉跑 8 次「两名 admin 同时退出」，7 次留下 `teams=1 / members=0 / admins=0` 的空壳团队——一个谁都看不见、也管不了的孤儿。没有这次实测，这把锁的必要性只是我的一面之词。

### 简化取舍
- **解散＝硬删除**，不可逆；级联由 schema 的 `onDelete: cascade` 一条 `DELETE FROM teams` 走通（projects → milestones/tasks/task_dependencies/task_labels/conversations → messages，外加 resource_usages、labels、team_members）。无软删/回收站/导出
- ~~**管理员不可被移除**（只能自己退出），故「移除管理员」是两步：先降级，再移除。~~ **[已废·图十]** 降级入口随后被撤（身份只由注册决定），「先降级再移除」这条路不复存在——管理员要离开只剩「自己退出并指定接任者」一条路
- **管理员不可被移除**（只能自己退出）。收益是「管理员」这个身份不会被别人单方面剥夺
- 末位 admin 不变量只保证「不再产生」无管理员的团队；**历史脏数据（已存在的 0 admin 团队）不受影响**，未做数据修复/巡检
- **`updateRoleAction` 由「裸 form action 抛错」改为 `useActionState` 范式**——否则新增的「末位 admin 不可降级」提示会渲染成整页错误界面。功能等价，属有意为之的行为改动
- 解散/移除/退出**均不发飞书通知**，与「结束资源占用」「撤销令牌」等既有操作一致
- 确认框的计数只有 项目/里程碑/任务/成员 四项（外加一句「以及对话记录、标签与资源占用」），未逐类列全
- 团队列表的内容计数为 4 条分组聚合查询（不分页、不缓存）；团队数很大时须重新评估
- 并发用例中「两名 admin 同时退出」一条**非确定性**：竞态测试无法保证两个事务一定交叠，实测缺锁时 8 次失败 7 次。**确定性防线是「两名 admin 互相降级」那条**
- **已知窄窗口（未修）**：`joinTeam` 先查团队存在再插成员行，若团队在两步之间被解散，插入会撞外键 23503，抛出一条未经转译的数据库错误。新增的解散入口让它从「理论上」变成「现实上」可达。修法：`joinTeam` 补一层 23503 → `AppError("团队已解散")`
- **单人团队里非管理员退出也会解散团队**（用户定的规矩：「团队只有自己一个人，则直接解散团队」）。此时该成员可能是学生、名下项目却由已退出的 admin 建立——**已确认按用户规则执行**，不做角色区分
- 队伍列表与成员页的确认文案点出数量，但**不做二次输入团队名之类的强确认**

## 图十（身份只由注册决定）备案

### 本役沉淀（教训）
- **规则一旦定成「无例外」，最先死掉的是所有旁路。** 「身份由注册时选定」这句话本身早在图三之前就实现了（`initialTeamRole`），本役实际做的是**把与之冲突的那条旁路删掉**（admin 改角色）。落地时才顺带牵出三处必须一起改的「死路提示」——`removeMember` 的 AppError、成员页那句「请先改其角色」、以及 README 路由表。**改一条规则时，要搜它名下所有「教人怎么绕过这条规则」的文案，它们会变成指错路的路标。**
- **删功能前先分清「产品能力」与「测试搭台」。** `updateMemberRole` 在网页上没了入口，但在 `tests/` 下有十几处调用（造 teacher、造第二名 admin）。更关键的是「两名 admin 互相降级」那条**确定性锁回归防线**只能靠它表达——网页入口一撤，就再没有别的写法。结论：**留在 lib 层并加注释讲明「不是产品能力、是测试梯子」**，而不是顺手删掉连带丢掉一片覆盖。注释比删除更贵，但删除是不可逆的。
- **徽章语义要区分「我是谁」与「我在这个团队里是什么」。** 团队列表那枚 `RoleBadge` 显示的是后者（建团者是 admin，与其注册身份无关），成员名单要的是前者。两者混用会让「导师身份的学生团队管理员」这类行显示得莫名其妙。今以 `IdentityBadge` / `RoleBadge` 两个组件把这对概念分开，前者复用导航栏既有的 `.ac-identity-*` 皮。

### 简化取舍
- **改身份的权力只从网页收回，lib 层的 `updateMemberRole` 保留**（测试搭台；产品代码零调用方）。**若日后从服务端代码调用它，「身份只由注册决定」这条规则即被绕过**——已在函数注释里写明
- **团队恒定一名管理员，没有副手**（有意为之，用户已确认）。加入者按身份只能是 teacher/student，改身份的入口又撤了，故不可能造出第二个 admin；换人只能靠「唯一管理员退出时指定接任者」
- **身份徽章的边界：`users.identity` 为空时退回按团队角色显示导师/学生。** 存量用户与飞书自动建号（`findOrCreateByFeishu` 不写 identity）都会走到这里；不这么做的话，一个当年被管理员设成 teacher 的存量用户会和普通成员长得一模一样。**这批用户目前没有任何途径补填身份**（只有注册页写 identity）——这条债留在此处
- **存量脏数据一律不订正**：已被改过身份的老成员、已存在多管理员的团队，保持原样；本改动只约束「今后」
- 成员名单与团队列表**措辞不统一**（同一个 student，在名单上叫「学生」、在团队列表叫「成员」）。两者指着不同的概念（身份 vs 角色），暂不强行统一
- `listTeamMembers` **不返回 identity**（项目详情页只用它填指派下拉，不渲染名册；AI 快照亦不需要），本轮不动
- 建团者**仍是 admin 而非其注册身份**——「身份只由注册决定」约束的是加入者，建团者是例外，与既有实现一致

## 时区（默认中国时间）+ AI 设置 + 徽标回欢迎页备案

（非作战图驱动的一役，起于用户报「时间不对」。故不占「图十一」这个号。）

### 本役沉淀（教训）
- **⚠️ 这份判词的第一条已被下一节推翻，留着当反面教材。** 当时读到 `Dockerfile` 与 `docker-compose.prod.yml` 都没设 `TZ`，就断定「容器双双跑 UTC 所以慢 8 小时」—— 方向正好**反了**：那套 UTC/UTC 的部署**碰巧是对的**，真正出错的是库会话跑在 +08 的本地与启动器。**通用教训：用户报「时间不对」时，先要到那个**具体的错值**（页面上的 `02:19`）与**产生它的那行数据**（库里的 `18:19`），再反推「这串数字是谁的钟面、被谁按哪个时区解读了」；不要拿「部署配置看着可疑」当根因。** 真正的根因与修法见下一节。
- **两种时间必须分开：时刻（`timestamp` 列）按用户时区换算；日历日（`date` 列与 `YYYY-MM-DD`）绝不换算。** 截止日是 9/1 就永远是 9/1。把日历日也拿去 `new Date()` 再格式化，会在日界附近把「9/1 截止」显示成 8/31 —— 修一个 bug 造一个。
- **顺手搜「今天」时，别只搜格式化函数。** 搜 `todayIn` 不够，要把所有**产生日期字符串**的写法都揪出来：`toISOString().slice(0,10)`、`CURRENT_DATE`、`setDate()`、`toLocaleDateString("sv-SE")`。本役翻出的最严重的一处正在这里：`notify.ts` 的 SQL 预过滤按**DB 时区**取行、JS 分桶按 **UTC** 比大小，两套日历口径打架，边界那天必然有人漏收或误收 —— 而这处跟「显示」毫无关系，纯粹是搜判断逻辑才搜出来的。
- **改全局时间格式化时，先列一张「哪些时间不是时间」的白名单。** 三处 `toISOString()` 差点被顺手改掉（`agent/commit.ts`、`agent/tools.ts` 的乐观锁版本令牌，`project.ts` 的 `isDateString` 往返校验）—— 它们是不透明令牌与字符串校验，不是给人看的时间。**统一格式化的动作必然会扫到这类变量**，不先列白名单就会静默改坏并发控制。
- **时区一旦可配，所有「按进程时区解析用户输入」的写法都必然错。** `resources/actions.ts` 原先用 `new Date("2026-10-14T20:30")` 解析 `datetime-local` 的墙面时间 —— 在单时区部署下碰巧对，时区一能改就必然错。新增的 `zonedWallClockToInstant(tz, ...)` 把它变成显式参数。**教训是通用句式：凡「碰巧成立」的地方，都是别人日后要踩的坑。**

### 简化取舍
- **存储层一字未动**：`timestamp` 列仍是 naive（无时区），`date` 列仍是 `date`，**存量数据一律不订正**。本役改的是「读」与「判断」，不是「写」——改存储会让新行按新时区落盘、老行保持旧时区，同一列混进两种含义。
- **~~「PG 时区 == Node 时区」仍是约定，不是运行时强制~~** —— **下一节已把它消掉**：应用改成按库会话时区读写以后，这条暗礁不存在了。原先设想的「启动时断言两边时区一致并告警」也就不必做了。
- **偏好为「跟随浏览器」（`auto`）的负责人，在 cron 里按站点默认（中国时间）算** —— 服务器上没有浏览器，拿不到本机时区。故一个「跟随浏览器」的人在国外时，飞书提醒里的「今天」会按北京时间算，与他页面上看到的不一致。要修得让 `TzSync` 把浏览器时区也落库（而不仅落到 cookie）。
- **`ac_tz` cookie 落地前，`auto` 用户首次渲染用的是默认值**，随后 `TzSync` 调 `router.refresh()` 自洽。一瞬，但确实存在。
- **`notify.ts` 的分桶口径变了，`tasksScanned` 的语义也跟着变**（从「SQL 取回的行数」改成「过筛后真正进日报的条数」）—— SQL 那层现在只能给**宽松上界**（按全球最东时区算的「明天」），多取回的行在 JS 里丢弃。**宽一层不漏行，窄一层必漏**，这个方向不能反。
- **~~「AI 设置」这个导航名指向的其实是「个人访问令牌」页~~** —— 用户随后要求「两个界面合并」，下一节已并成一页，措辞与去向不再打架。
- **`listTimeZones()` 把 ICU 全量时区（约 400+ 项）下发到客户端**，选项列表偏长（置顶了「中国时间 / 跟随浏览器 / UTC」三项）。未做搜索框或按地区折叠。
- **夏令时「跳过」的那一小时**（如美西 2026-03-08 的 02:30 在当地并不存在）在 `zonedWallClockToInstant` 里会被挪到相邻的真实时刻；往返一致性测试刻意避开了那一小时，未做「该时刻不存在」的拒绝。
- **时区偏好不进 JWT**：每请求重新读库（layout 早已为取身份读过 users 行）。好处是改完即生效、不必重登；代价是每请求多一列，可忽略。
- **时区卡片用非受控 `select` + `defaultValue`**，本地只存「刚选、还没提交」的值，真值永远是服务端给的 `pref`。这是为了避开 ESLint 的 `react-hooks/set-state-in-effect`：**没有用 eslint-disable 压制**，而是让「提交成功后两者自然重合」，从此不需要任何同步 effect。
- **顶栏导航、徽标去向之外的结构一律未动**；`/settings` 与 `/settings/tokens` 当时仍是两个页面、非父子路由（下一节已合并）。
- **存储层「不改写」这条原则，在下一节被打破了一次**：修读写口径时不得不给写方向加一层显式换算（否则写进去的钟面与 `now()` 的不同源）。**不改的是数据本身，不是写入代码** —— 这个区别当时没写清，容易被后来者误读成「写也不能动」。

## 时区修正（第二轮）：无时区 `timestamp` 的读写口径 + AI 设置与令牌页合并

（用户回报「时间还是错的」，并点出两个具体错值：任务详情页「创建于 2026-10-15 02:19」、
活动日志「2026-10-15 02:23」。同一役里还要把「AI 设置」与「个人访问令牌」并成一个界面。）

### 根因：不是时区没生效，是**写入口径与读入口径不是同一个**

库里的数据（实测启动器的运行库）：

| 列 | 库里的墙面时间 | 写入方 |
| --- | --- | --- |
| `tasks.created_at` | `2026-10-14 18:19:13.850195` | `defaultNow()`（= PG `now()`） |
| `tasks.updated_at` | `2026-10-14 18:23:00.164206` | `sql\`now()\``（`lib/task.ts`） |
| `task_activities.created_at` | `2026-10-14 18:19:13.85264` | `defaultNow()` |

同一时刻写成三个「18:19」，而 PG 的会话时区是 `Asia/Shanghai` —— 也就是说**存下来的是 +08 的钟面**。
读的那一头，drizzle 对**无时区** `timestamp` 列的默认映射是 `new Date(值 + "+0000")`，
即**假定这串钟面是 UTC**（`node_modules/drizzle-orm/pg-core/columns/timestamp.js:31`）。
于是 `18:19` 被读成 `18:19Z`，按北京时间显示就是次日 `02:19` —— 与用户看到的逐字吻合。

**为什么生产没事、本地和启动器有事**：这套读法只在**库会话时区是 UTC** 时自洽。
`docker-compose.prod.yml` 那套（两个容器都不设 `TZ`，同跑 UTC）碰巧满足；
本机 PG 与启动器自带的 PG 都是 +08，就整整差 8 小时。

**为什么会形成「两种写入口径」**（这是最值得记的一条）：
- PG 往无时区列里塞带 `Z` 的串时，**静默丢掉偏移、直接取字面量**。
  所以应用显式传 `Date` 时（drizzle 走 `toISOString()`）落盘的是 **UTC 钟面**；
- 而 `now()` / `defaultNow()` 是 timestamptz 赋给 timestamp 列，PG 会先按**会话时区**换算，落盘的是 **+08 钟面**。

两套口径写进同一列，各自自洽，谁也没报错。

**为什么本地测试全军覆没**：冒烟脚本里凡是「写一个值再读回来」的断言（资源登记 `20:30` 往返、
切时区平移 8 小时）在两个方向上都走同一套口径，**恒等**，看不出问题；
唯一会露馅的是「数据库自己写的时间」，而当时的断言没有把它钉在绝对时刻上。
**通用教训：跨「进程边界」（这里是 PG 与应用）的口径一致性，不能只靠往返断言，要拿两个来源各自的产物对撞。**

### 修法：读写都按**库会话时区**换算，两个方向都显式

- `src/lib/time.ts` 新增 `dbWallClockToInstant(tz, 文本)` 与 `instantToDbWallClock(tz, Date)`
  （复用既有的 `offsetMsAt` 两步迭代，微秒截到毫秒）。
- `src/db/schema.ts` 新增 `dbTimestamp` / `dbTimestampNow`（`customType`），
  **全部 20 个时间列改走它们**；连上库时用 `SHOW timezone` 探明会话时区（`src/db/index.ts`，模块级 await 一次）。
- 于是**库会话时区配成什么都对**：UTC（生产）行为逐字不变，+08（本机/启动器）得到修正，
  **存量数据不用订正** —— 因为按 +08 读 18:19 正是它当初被写下的那一刻。

### 本役沉淀（教训）
- **物理 schema 与「列怎么映射」是两件事。** `customType({ dataType: () => "timestamp" })` 生成的 DDL
  与 drizzle 自带 `timestamp()` 完全一致 —— 用 pg_dump 比对新旧 schema 建出来的两个库，**逐字节相同**，
  再用新 schema 去 push 一个「旧代码建的」库得到 `No changes detected`。**这就把「改映射」与「改表」彻底分开了**，
  否则改列类型（比如换成 `timestamptz`）会牵动存量数据迁移，那是另一量级的风险。
- **同步的列映射 + 异步的元数据，用「模块级探明一次」解。** 列映射必须是同步函数，没法在里面查库；
  故在 `src/db/index.ts` 里 `await` 一次 `SHOW timezone` 存进模块级变量，映射闭包按需读。
  **兜底值刻意选了 UTC**：与改动前行为一致，且真探不到时（库都没起来）后续任何查询本来就会失败。
- **上一个数字型常量（20 个时间列）要有人守着。** `tests/db-timestamp.test.ts` 数了列数并逐一断言
  `getSQLType() === "timestamp"`、断言 `feishuBoundAt` 等**没有**默认值（防止 `dbTimestamp` 手滑给可空列加上默认值，
  那会驱动 `db:push` 去 ALTER）。**「没变」这件事也值得写测试**，否则下次改动的 diff 里看不出来。

### 简化取舍
- **不给存量数据做订正**（理由见上：按会话时区读，老数据本来就对）。也没有 `UPDATE ... - interval '8 hours'` 这类动作 ——
  那得先假设「旧数据全是 +08」，而生产那套库其实是 UTC，同一句 SQL 会把生产改坏。
- **不改成 `timestamptz`**。那是最「正统」的解法，但要按库逐个跑 `ALTER ... USING ... AT TIME ZONE`，
  且应用显式写入的那几列（`feishu_bound_at` / `resource_usages.start_time`）还是 UTC 钟面，
  得另写一句 `USING ... AT TIME ZONE 'UTC'` —— 一句 SQL 里两种口径，风险高于收益。
- **没做「库会话时区中途被改」的防护**。真改了，老行按旧时区读、新行按新时区读，还是错位。
  README 把这条写成了显式警告（**千万别对已运行过的库就地改时区**），但没做运行时检测。
- **`db/index.ts` 用了模块级 `await`**（top-level await）。Next 的服务端模块支持，但这是本仓第一处，
  若日后在 Edge runtime 或某些打包路径下报错，优先怀疑这里。
- **合并设置页的形态：并进 `/settings`，`/settings/tokens` 变成一跳的重定向**。
  没删旧路由（书签、外部文档、飞书回跳都可能带着它），也没改 `(app)` 这层的鉴权结构。
  令牌的服务端动作从 `settings/tokens/actions.ts` 挪进 `settings/actions.ts`（一页一个动作文件），
  `revalidatePath` 跟着从 `/settings/tokens` 改成 `/settings`。
- **顶栏「AI 设置」现在指向 `/settings`** —— 这是这一役里唯一一处导航改动，正是因为「两页合并」本身要求它；
  上一轮「只改标题、导航不动」的前提已经不存在了。

## 图十一（控制台助手 + 个人上下文）简化备案

（用户要：「在控制台加一个 AI 助手聊天框，和项目助手共用一个 API，做好用户隔离，个人上下文功能也加上，
项目助手要有项目里面所有人的上下文」。已确认四条口径：控制台 = **工作台页内**一张卡；能力**与项目助手同权**；
上下文**默认全部可见、每条可标「仅自己」**；**手填 + 助手拟草案后人工确认**。）

### 一表两态：为什么没有另开 `personal_conversations`

`messages` 只认 `conversationId`（一条外键）。另开一张会话表，就得把这条外键劈成两半
（`project_conversation_id` / `personal_conversation_id` + CHECK 二选一），
或者给 `messages` 也加一列 kind —— 两条路都比「同表加两列」更绕。
于是 `conversations` 加 `kind` + `ownerId`（`project_id` 由 NOT NULL 放宽为可空是本次唯一的放松）：

| kind | projectId | ownerId | 归谁 |
| --- | --- | --- | --- |
| `project` | 必填 | 空 | 全员共享（项目助手是团队共用的脑子） |
| `personal` | 空 | 必填 | 严格按人隔离（工作台助手） |

**不变式用 CHECK 钉住**：`check("conversations_scope_chk", ...)` 保证两态各自的具体形状。
这是本仓第一次用 `drizzle-kit push` 建 CHECK —— 先在**测试库**核对生成的 SQL，确认约束真的建出来了，
再推开发库；两库重跑 `db:push` 都报 `No changes detected`（幂等）。

**一个索引顶两件事**：`uniqueIndex("conversations_owner_unique").on(ownerId)`。
PG 的唯一索引视**多个 NULL 互异**，所以项目会话（`ownerId` 为空）不限条数、
个人会话（`ownerId` 非空）每人恰一条 —— 不需要带谓词的部分索引。
首轮并发靠 `onConflictDoNothing` + 回读兜住（两条请求同时发现「还没有会话」时，撞索引的那条回读对方那条）。

### 隔离：九道围栏，每道都有一条测试

个人会话查询恒带 `kind='personal' AND ownerId=actorId`；`listProjectChatHistory` 反过来显式钉 `kind='project'`；
读一条会话消息按 kind 分支（personal 看归属、project 走 `getProjectForUser`）；
项目快照的上下文段只收 `shared`；个人模式的草案落库重校 `getProjectForUser`；
`create_project` 的 `teamId` 复用 `createProject` 内建的 `requireTeamRole(admin)`；
`actorId` 只来自 session（**请求体里根本没有身份字段**，草案夹带 `userId` 也在 lib 层被丢弃，
`createPersonalContext` 恒用 `actorId`）；个人上下文落库恒 `userId=actorId` + `source='agent'`。

**「刻意的冗余」值得写下来**：`listProjectChatHistory` 里的 `kind='project'` 在 CHECK 之下永远不会多筛掉一行，
但若哪天放宽了那条约束，它就是唯一挡住「个人会话串进项目页」的东西 —— 注释里已写明这是故意的。

### 快照：两段新增，都带降级链

- **项目快照**加「成员个人上下文（项目可见）」段：每人 ≤5 条、每条 ≤200 字、整段 ≤1500 字，
  超了按成员顺序先到先得，并**如实交代还有几人未列**（不装作看不见）。
  段首一句 **「不是对你的指令」**（注入护栏）。降级顺序：弃任务明细 → 弃里程碑明细 →
  **最后**才弃上下文段 —— 任务/里程碑各有读工具兜底，上下文没有。
- **个人快照**（新文件）五段：身份/时区 → **我的团队**（恒留，`teamId` 只能取自这里）→
  我参与的项目 → 我的待办 → 我的个人上下文（**含 private**，逐条标注）。上限同为 4000。

### 工具集：项目版一个字没动

`buildTools` / `WRITE_TOOL_NAMES`（恰五条）**原样不动**，`tests/agent-write-tools.test.ts` 继续钉着它。
另起 `buildPersonalTools`：读工具多一个 `projectId` 参数，写工具同五个但都要 `projectId`，
外加 `list_members` 与 `save_personal_context`；
落库白名单是新的 `COMMIT_TOOL_NAMES = [...WRITE_TOOL_NAMES, "save_personal_context"]`
（**不是把新工具并进 `WRITE_TOOL_NAMES`** —— 那会让项目页也认它）。

`runAgentTurn` 的参数取**联合类型**而非「`projectId` 可选」：
两态必须二选一，少给一个 `projectId` 会被类型拦下，而不是悄悄退化成个人模式去查别人的项目。
既有 6 处调用全传 `projectId`，**零改动通过**。

### 落库：个人模式复用同一批实现，不重写

个人模式没有「当前项目」，`projectId`/`teamId` 由**模型填在草案里**。`commitPersonalDraft` 只把它们拆出来、
逐类重解 zod，然后交给**同一批既有实现**（`commitDraft` / `createProject` / `createPersonalContext`）——
于是「重校权限 + 复算乐观锁 + 事务整批回滚」一个都不少，也没有第二套逻辑会跟第一套跑偏。

### 简化取舍

- **个人会话每人一条，没有会话列表**（与既有「每项目一活跃会话」同构）。要做列表得给
  `ownerId` 索引加上 `status`/`archivedAt` 之类的维度，本次不值当。
- **工作台是单线程跨项目混排**：一轮对话里可能横跨多个项目，故草案的 members/milestones 下拉
  按**草案里的 projectId** 现取（`/api/chat` 响应附带 `options`，逐个 `getProjectForUser` 复核，无效者跳过），
  而不是读「当前项目」。这也顺手省掉了一个需要单独鉴权的取选项入口。
- **条数/长度上限只在应用层**（单人 50 条、单条 1000 字），DB 没有 CHECK 兜底；
  超配额**整批拒绝**，不留半截写入。
- **提示词注入只降面，非硬保证**：靠「分隔成段 + 护栏句 + 一切写入走确认 + 落库重校权限」四件套。
  上下文内容在**写入口**归一化（折 CRLF、剔零宽/方向控制字符/行分隔符/BOM，保留 `\t` 与换行）——
  看不见的字符既是最好的注入载体，也是「看着是空条目」的常见成因，一次做净后读端不必再防。
- **「项目可见」是默认值**（用户确认的设计）：个人备注会被队友通过项目助手看到。
  既然这是设计而非疏漏，UI 就必须说清楚 —— 条目上挂着可点的可见性徽章，表单与卡片说明里都写了后果。
- **个人模式的 `projectId` 由模型自填**，落库重校兜底；模型若拟到用户无权项目，表现为 403，**属预期**。
- **真实模型回合未演武**：本机 `.env` 的 `DEEPSEEK_API_KEY` 是空串，故工作台助手走到模型那一步只能验到
  `400 DeepSeek 未配置：请在 .env 设置 DEEPSEEK_API_KEY`（是明确报错，不是 500 裸崩）。
  上下文的手填/删除/切换可见性、草案的落库路径都已经用**真实登录会话**的 HTTP 冒烟验过，
  但「模型自己决定调哪个工具」这一环在本地没有跑过。

### 本役踩到的两个本机坑（与代码无关，但会咬人）

- **Windows 下别把中文塞进命令行参数**：`curl -d '中文'` 与 `psql -c "中文"` 经 MSYS argv 交给原生 Windows 程序时
  会被转成 GBK —— 写进库是乱码，或直接被拒。改用 node 的 `fetch` 发请求 / `-d @file`。heredoc 写文件是 UTF-8 安全的。
- **源码是 CRLF，node 脚本里拿 `\n` 当锚点会静默匹配失败**（replace 原样返回，`s === before` 之类的自检还可能被前一处
  replace 掩盖）。锚点要带 `\r\n`，或干脆按行号改。

## 助手「续接上文」+ 记忆条数旋钮（图十一 追加）

（用户要：「让 AI 助手可以看到先前所发的消息，可以连续之前的对话，并在个人上下文展开窗口里面
可以设置 AI 可以看到的聊天记录上文条数」。此前助手每轮只发本轮那句话 —— 界面**看得见**历史，
模型**看不见**，于是它接不上「它」「再改一下」这类指代。）

### 设计取舍

- **旋钮做成用户级偏好（`users.ai_history_limit`），不做成「每个会话一个数」。**
  个人会话是懒建的（首轮发言才建），存会话上就得先建会话才能存偏好；项目会话是共享的，
  存会话上就变成「谁最后改谁说了算」。用户级一句话说得清：我允许助手看多少条。
  代价：**两个 scope 共用一个数** —— 工作台助手与项目页助手按同一个 N 来（界面已写明）。
- **范围 0–50、默认 10**（一问一答算 2 条，即默认约五轮）。0 是合法值且含义明确（失忆），
  故「空输入」不能当 0 —— `Number("") === 0` 这个 JS 陷阱单拎出来判，空串按「恢复默认」处理。
- **纯模块与库模块分家**：常量/钳制在 `src/lib/agent/history-limit.ts`（客户端组件引它显示 min/max），
  存取在 `src/lib/agent/memory.ts`（引 `@/db`）。照 `lib/time.ts` 对 `lib/time-pref.ts` 的先例 ——
  **客户端组件一旦引入引了 `@/db` 的模块，postgres 驱动就进浏览器包**。
- **单条消息不截断**，只限条数。贴一篇长文进输入框会原样进提示词，占满上下文的风险由用户自己看着办。
  真出问题再加「单条截到 N 字」，那会改动提示词语义，先不做。

### 沉淀（三个真会咬人的点）

1. **「最近 N 条」要倒序取再反转**。写成正序取 limit 条，拿到的是**这段对话的开头** ——
   助手会拿几天前的开场白回答今天的问题，而且测试若只断言「有条数」根本发现不了。
2. **同一轮的问与答 `created_at` 逐字相等**：两者走同一条 `INSERT`，PG 的 `now()` 在一条语句里
   取值相同。只按 `created_at` 排序，同一轮里会出现「答在问前」——排序键里必须补一个
   `case when role='assistant' then 1 else 0 end`（答在下、问在上）。**这也解释了为什么
   `persistTurn` 的两行不能拆成两条 INSERT。**
3. **反转后开头若是「答」就要丢掉**：条数切成奇数、或只取到一条回答时极易发生，
   既没有意义，也有些模型不接受以 assistant 打头的 messages。

### 顺带记一笔

- 上文的取数**天然不含本轮**：`persistTurn` 在模型答完之后才写库，故本轮那句拼在末尾即可，
  不必去重。顺序上依赖这一点，改成「先落库再答」会引入重复。
- 测试断言 prompt 时要注意：AI SDK 交给 provider 的每条消息，`content` 都是**部件数组**
  （纯文本 = 单个 `{type:"text"}`），不是字符串。别照着自己传进去的字符串去断言。
- README 的「助手会话的两种 scope」一节补了这条约定（含排序键与「别把 db 拖进纯模块」的告诫）。

## 个人写工具漏带 projectId：转派任务在「确认」那一步才炸「草案格式无效」

（用户报：「我用AI助手转派任务的时候会碰到这种问题：待确认：批量变更（2）……草案格式无效」）

**根因是两个 scope 的约定不对称。** 项目版的 `projectId` 由请求体给（工具 schema 里根本没有它）；
个人版没有「当前项目」，只能从**草案里**取（`commitPersonalDraft` 拆出来交给项目版实现）。
`buildPersonalTools` 的五件写工具里四件是 `draftEnvelope(tool, input)` —— projectId 天然带上；
唯独 `update_tasks` 要手工拼信封（补读时版本号），`projectId` 就漏在了解构之外。
于是卡片照常渲染（它只读 `patch`），点「确认落库」才在落库口抛 ZodError，
被 `/api/chat/commit` 统一翻译成「草案格式无效」——**报错点在落库，病因却在拟稿**。

同一个漏字段还顺手废掉了卡片的下拉框：`collectDraftOptions` 也是按草案里的 projectId 去查选项的，
拿不到 id 就没有 members/milestones 可给。

**为什么测试没拦住**：既有用例「update_tasks 草案补上读时版本号」只断言 `taskId`/`updatedAt` ——
而这两个字段正是那处手工拼装里**唯二的产物**，漏掉的那个恰好不在断言里。
「只测改动过的字段」这种写法，围栏正好开在缺口上。

**修法与围栏**：

- 信封补上 `projectId`（**只改个人版**；项目版故意不带，别顺手"统一"）。
- `commitPersonalDraft` 缺 id 时改抛可诊断的 `AppError`（「草案里没带项目 id，请让助手重拟一次」），
  不再被笼统的「草案格式无效」盖住。
- `tests/agent-personal-tools.test.ts` 新增一组围栏：**逐件**把五件写工具的草案原样喂给
  `commitPersonalDraft`，断言「带着落库口要的那个 id」且 `committed > 0`。已实测：把 `projectId`
  改回去，两条用例立刻红。这类「拟稿丢字段、落库才炸」的错，只有把**整条链子**（工具 → 信封 →
  落库口）串起来测才拦得住。

**顺带改了卡片的可读性**：`update_tasks` 原来把 `{"assigneeId":"b0b0…"}` 原样 `JSON.stringify`
出来 —— 转派时根本看不出转给谁。现按字段名渲染中文标签 + 可改控件（负责人/里程碑取响应里的选项）。
**选项查不到时退化为只显示 id，不给空下拉**：空下拉看着像「未分配」，确认下去却仍是原来那个人。
认不出的字段（模型将来加的新字段）照原样显示，不假装能改。

## 同一条链子的系统排查：还有三处会「拖到确认那一刻才炸」

（用户要：「顺便看看还有没有类似的问题修一下」。做法是顺着
**工具信封 → 落库口 zod → 卡片字段 → 路由请求体** 逐段比对，且每条都拿代码实测过，
不靠读代码下结论。）

### 1. 日期框清空 → 空串直通 date 列 → 500（最重的一条）

卡片上把日期框清空，浏览器交出来的是**空串**。它骗过 `z.string().optional()`，也骗过 lib 里
`if (d && !isValidDate(d))` 这种真值判断（空串 falsy = 「没给」），最后撞在 PG 的 date 列上。

实测（把修复拿掉再跑）：

| 调用 | 结果 |
| --- | --- |
| `updateTask({ dueDate: "" })` | PG 报 `invalid input syntax for type date: ""` |
| `createMilestone({ targetDate: "" })` | 同上 |
| `createProject({ startDate: "" })` | 同上 |
| `updateTask({ dueDate: null })` | ✅ 成功，字段被清空 |

用户看到的是路由兜底的 **500「落库失败，请重试」** —— 与上一轮那句「草案格式无效」同一个毛病：
报错点与病因隔着好几层。

**修法**：落库口加 `optionalDate`（空串一律当**没给**）；`update_tasks` 的 patch 收 `null`
（=「清掉这个日期」）；卡片里三个可选日期框清空即 `undefined`，只有 `update_tasks` 的日期框
清空送 `null`（模型提的日期被用户删掉，意思显然是不想要它）；`plan_sprint` 的截止日是必填，
空串在 zod 这关就被拦下，且报错带字段名。

**围栏**：`tests/agent-commit.test.ts` 新增「日期字段的空串与 null」一组。已实测把 normalization
拿掉，用例立刻红在 `invalid input syntax for type date: ""` 上。

### 2. 必填框被清空/删空 → 也要等到点确认才报「草案格式无效」

项目名、里程碑名、任务标题被清空，或把拆解列表删到空 —— 这些在落库口的 `min(1)` 上才翻车，
回给用户的还是上一轮那句笼统话。**卡片本来就把字段摊开给人改了，那就该在改的地方拦**：
`CardShell` 加 `invalid` 通道，有值即禁用「确认」并把差什么写出来（`firstProblem` 挑第一处）。
一处机制、五个分支各自给文案，不新开校验层。

### 3. 个人版 `create_project` 的 teamId：工具与落库口形状不一致，且没有守卫

工具 schema 是 `z.string()`，落库口是 `z.uuid()`；而上一轮只给 projectId 加了守卫。
于是「缺 teamId / 把团队名填进去」还是只会得到最笼统那句。**修法**：

- 守卫补齐（「草案里没带团队 id，请让助手重拟一次」）。
- 五个写工具的 id 参数（personal 的 projectId/teamId）钉成 `z.uuid()`：形状不对在**工具调用当轮**
  就失败、模型自己就能改，而不是留一张点了必炸的卡。**读工具仍是 `z.string()`** —— 它们的失败
  当场发生、当场重试，没有「拖到确认才炸」的问题。
- `personalCreateProjectSchema` 改成 `createProjectSchema.extend({ teamId })`，两处字段定义从此
  不可能再各写各的。

### 顺带：军规 3 在个人 scope 指了一个不存在的段

「assigneeId 只能用快照『成员』段落里的 id」—— 个人快照里**没有**成员段（那是项目助手的常驻段）。
已在个人 scope 的说明里点破，别让模型满世界找它。

### 一处当时刻意没做、后来按需求开了（仍需真模型先验）

**当时没让「助手自己清空日期」。** 要表达「清掉截止日」，工具 schema 得从 `z.string().optional()`
变成 `.nullable()`，转成 JSON Schema 就是 `anyOf:[string,null]`。当时因本机无法跑真实模型而收手。

**[2026-10-19 更新]** 「管理任务详情」需求要求助手能清空描述/起始日/完成说明，故
`update_tasks.patch` 的 `description` / `startDate` / `completionNote` 已改为 `.nullable()`，
军规 10 说明「传 null = 清空」。**风险照旧**：真实模型回合仍未在本机验证过；若部署后
provider 对 `anyOf:[string,null]` 挑食，先把这三处退回 `z.string().optional()`（用户仍可在卡片上清空）。
`dueDate` 保持不变（仍是 `z.string().optional()`）。

### 另一件系统性的：路由不再只说「草案格式无效」

`/api/chat/commit` 收到 ZodError 时改回 **`草案格式无效（字段路径）：具体原因`**。
上一轮的漏 projectId、这一轮的 teamId 形状，最终都撞在同一句话上；带上路径后，
下一个人（或下一次的助手）一眼能看到是哪个字段、差在哪。

## 助手：任务起始日 + 任务详情 + 后置任务（2026-10-19）

### 决策
- 依赖边维持「后置须与前置同级（同 `parentTaskId`）」，不改 lib 校验。
- 助手写依赖用**增量** `add` / `remove`，不做全量替换：模型漏列旧边不会误删。
- 对外 REST 同步开放：`PATCH /tasks/{id}`、`POST /tasks/{id}/successors`、`GET /projects/{id}/dependencies`。

### 简化备案
- **历史跨层级依赖边只读。** `applyTaskSuccessorDelta` 对「remove 跨层级边」明确报错，
  不给模型「返回成功但边还在」的假象（`setTaskSuccessors` 的 preserve 选项会让删除静默无效）。
- `setTaskSuccessors` 仍是全量替换：只要同级集合变化，该前置任务的旧边会先删再插（含历史跨层级边）。
  助手侧靠 delta 只动提到的边，但底层语义没变。
- 依赖边无版本字段，增量接口按 last-writer-wins；**不要**拿 `task.updatedAt` 冒充边版本。
- `PATCH /tasks/{id}` 不加乐观锁（与 `PATCH /projects/{id}` 口径一致）。
- `GET /tasks/{id}` 只追加 `predecessors` / `successors`，不塞 `subtasks`（另有端点 12）。
- `edit_task_links` 的草案带展示字段（前置标题、现有后置）；落库 schema **不加** `.strict()`，
  展示字段由 zod 自动剥离。
- 真实模型回合（选工具、传 `null` 清空）本机无 key，未验；见上文「需真模型先验」。
- 跨层级依赖的**新建**仍然做不到（同级规则）；助手被要求如实说明，不要硬调工具换一个含糊报错。

## 助手：多动作连续执行 + 项目读历史/留言 + 工作台读消息（2026-10-19）

### 决策
- 「依赖新 id 的动作」用**显式「继续处理后续动作」按钮**跨轮补做，不做自动续做：
  自动续做会在用户还在编辑其他卡时抢跑，也容易形成循环与不可控的 token 消耗。
- 同一轮多个独立动作靠提示词 + 8 步预算 + 草案全量收集（本来就支持多卡），不引入新的编排状态机。
- 助手读消息新开**只读变体**（`listDmMessagesReadOnly` / `listGroupMessagesReadOnly`），
  不改 `read_at` / `last_read_at`、不建联系人；`listMessages` / `openGroupConversation` 行为不变。
- 群邀请只拟草案，确认后经 `commitGroupInviteResponse` 落库；它不进 `WRITE_TOOL_NAMES`，项目页天然拒收。

### 简化备案
- **未确认卡片按原始草案摘要**：卡片内的编辑态归 `DraftCard` 所有；已落库卡用用户确认后的当前数据，
  未落库卡只能按模型原始草案复述，并明确告诉模型「不要动它们」。
- **无自动去重**：模型若无视提示仍可能重复出卡；自动过滤会误伤合法的重复动作。
- **个人工具 18 件**（项目 15 件）：工具选择质量有退化风险。日后若退化，优先合并
  `list_project_activity` 与 `list_my_task_activity`，本次不做。
- `listConversations` / `listGroupConversations` 为算预览读全量消息是既有性能债；
  助手概览只截前 20 条，未改动底层。
- 只读工具**不改变未读**是特性不是 bug；提示词已要求如实说明，但模型仍可能口误。
- 项目助手未加「代发留言」，工作台助手未加「代发私信/群消息」——均按用户口径不做。
- 本机无 `DEEPSEEK_API_KEY`，真实模型的工具选择未验；靠 prompt 断言 + mock 编排覆盖，
  部署后需在有 key 的环境验：一轮多卡、继续补做、读历史/留言、读消息并拟草案、处理群邀请。

## 助手：消息文件进任务附件 + 子任务与附件管理（2026-10-19）

### 决策
- 消息附件 → 任务附件采用**复制字节**，不共享行、不新增引用列：
  `dm_attachments` 与 `task_attachments` 无外键，复制让消息删除与任务附件生命周期互不牵连；
  代价是同一文件存两份（单文件 ≤10MB）。本次无 schema 变更。
- 子任务的新增/删除各开一个项目写工具（`create_subtask` / `delete_subtask`）；**修改复用 `update_tasks`**
  （子任务就是任务，没必要再造一件只差校验的工具）。
- 附件管理只做项目助手侧的「查看 + 删除」；上传仍需网页表单，助手不接收二进制。
- `read_messages` 的 `attachment` 补 `attachmentId`（原先只回文件名/大小），模型才有可传的 id。
- `create_subtask` 进「可续做」清单（新子任务会派生新 id）；删除类与消息附件复制不进。
- 新增写工具进 `WRITE_TOOL_NAMES`，项目页落库口直接可用；`attach_message_file_to_task` 只进
  `COMMIT_TOOL_NAMES`，由 `commitPersonalDraft` 分派。

### 简化备案
- **没有 bin 级去重**：同一消息文件可被多次复制成同名任务附件；未做「已存在则复用」判断。
- **不能重命名附件**：lib 与网页都无重命名能力，本次不新增（管理 = 查看/删除/复制）。
- **不开放 REST**：本次只补助手工具面；`/api/agent/*` 仍无附件端点，子任务端点维持原 GET/POST。
  （后续已补齐：见下一节「助手：发送 / 转发 / 建群 + REST」。）
- **删除子任务会级联**：沿用 `deleteTask` 的既有语义（连同其下级子任务与依赖），卡片与工具描述都明确警告。
- **助手仍不能上传新文件**：没有二进制输入通道；「把消息文件加到任务」是唯一的助手侧新增附件路径。
- **个人 scope 只加一件工具**（消息附件复制），未把 `list_attachments` / `delete_attachment` / 子任务工具
  复制到工作台助手，避免工具集继续膨胀（个人 19 件、项目 19 件）。
  （后续修订：`list_attachments` 已补进工作台助手——发送项目文件必须拿到真实 `attachmentId`，
  见下一节；`delete_attachment` 与子任务工具仍只在项目助手。）
- 本机无 `DEEPSEEK_API_KEY`，真实模型能否正确串起
  「read_messages → 取 attachmentId → attach_message_file_to_task」未验；部署后需在有 key 的环境补验。

## 助手：发送 / 转发 / 建群 / 邀请 + REST 补齐（2026-10-19）

### 决策
- 发送类动作**仍然两段式**：`send_message` / `forward_message` / `create_group_chat` 只产草案，
  没有「直接调用就落库」的旁路；确认后由 `commitPersonalDraft` 重解 zod、重校目标/成员/附件权限。
- 助手落库与 REST 共用 `src/lib/chat-transfer.ts`：目标解析、附件字节读取、发送都只有一份实现，
  避免两处各写一遍权限校验而逐渐分叉。
- 建群沿用网页语义：成员被**直接拉入**，不是发邀请待接受。助手侧改收**用户名**而不是
  `userId`——模型誊抄 uuid 易错（抄错一位、或引用上一轮旧 id，症状是「邀请的成员不存在」），
  用户名则是 find_contact 直接给出、模型也更容易照抄的字段。名单里的自己被过滤；
  允许 `usernames` 为空，先建一个只有群主的群，之后再邀请。
- `send_message` 的附件用扁平 `fileSource` + `attachmentId`（而不是嵌套对象），与卡片编辑态、
  zod 剥离展示字段的做法保持一致；两者必须同时给出。
- `forward_message` 必须带 `sourceId` 并校验与消息实际所属会话一致：私信填对端 userId、群聊填 groupId，
  防止拿一条群里看到的消息冒充私信源。
- `create_group_chat` 进「可续做」清单（新 groupId 可派生后续发消息）；发送与转发不派生后续动作。
- 邀请与建群语义分开：`create_group_chat` 直接拉人（网页建群行为），`invite_to_group`
  只落**待处理邀请**，对方接受后才入群。拟稿与落库共用 `resolveGroupInviteTargets`，
  保证「卡片能确认」和「确认能成功」的口径一致；批量邀请在一个事务里插入，任一条失败整批回滚。
- REST 只补消息/联系人/建群/转发/邀请/附件/子任务删除；读消息复用只读变体，不置已读。
- 工作台助手补 `list_attachments`：`get_task_detail` 不返回附件，而 `send_message(fileSource="task")`
  必须给真实 `attachmentId`，否则「把项目文件发给别人」根本拟不出草案。该工具只读，
  内部按任务实际所属项目校验成员身份（个人 scope 没有「当前项目」）；`delete_attachment`
  仍只在项目助手。

### 简化备案
- **联系人只做用户名精确匹配**：模糊搜索会把全站用户名变成可枚举接口，本次不做。
- **REST 不接受二进制上传**：附件只能用已有 id 引用（任务附件或消息附件）；上传仍走网页表单。
- **不提供消息删除/撤回/标已读端点**：读接口刻意只读，避免外部程序改掉用户的未读状态。
- **转发不编辑正文**：`forward_message` 是「原样转发」，卡片只读展示；要改文案请先发送新消息。
- **跨表附件仍是复制**：项目文件发出去、消息文件转发都会复制字节进 `dm_attachments`；
  同一文件可能存多份，单文件上限仍 10MB（`DM_ATTACHMENT_MAX_SIZE`）。
- **群成员管理 REST 只补了邀请**：退群/踢人/查看群内待处理邀请不在本次范围。
- **批量邀请是「全成或全不成」**：一人已在群里、已邀请过或名字不存在，整批都不落；
  错误文案只报第一处问题，不逐人列出全部失败原因。
- **邀请不会自动续做**：邀请不派生新 id，落库后不出现「继续处理后续动作」按钮。
- **没有发送频率限制**：与网页发送一致，未加额外限流；滥用仍需靠令牌撤销兜底。
- 本机无 `DEEPSEEK_API_KEY`，真实模型能否正确选 `find_contact → send_message`、
  并在多步里先找人再拟稿未验；部署后需在有 key 的环境补验：
  「找一下 zhouyu，把这张图的文件发给他」「把群里那条消息转发给小乔」「建个三人群」
  「把 zhouyu 和小乔拉进讨论组」。
