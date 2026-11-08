/**
 * 项目概览：Notion 属性面板风格的项目信息卡（纯只读展示，无交互）。
 * 放在项目页最顶部，集中呈现状态、周期、进度、成员、里程碑与描述。
 */
export function ProjectOverview({
  project,
  taskTotal,
  taskDone,
  members,
  milestoneCount,
  pendingAcceptance,
}: {
  project: {
    description: string | null;
    status: string;
    startDate: string | null;
    endDate: string | null;
  };
  /** 项目内全部任务数（含子任务） */
  taskTotal: number;
  taskDone: number;
  members: { id: string; name: string }[];
  milestoneCount: number;
  pendingAcceptance: boolean;
}) {
  const statusBadge =
    project.status === "active" ? (
      <span className="ac-badge bg-doing/10 text-doing">进行中</span>
    ) : project.status === "completed" ? (
      <span className="ac-badge bg-done/10 text-done">已结题</span>
    ) : (
      <span className="ac-badge bg-sunken text-ink-soft">已归档</span>
    );

  const pct = taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : 0;

  return (
    <section className="ac-card p-5">
      <h2 className="font-medium text-ink">项目概览</h2>
      <div className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <Property label="状态">
          {statusBadge}
          {pendingAcceptance && (
            <span className="ac-badge border border-medium bg-medium-soft font-medium text-medium">
              ⏳ 结题审批中
            </span>
          )}
        </Property>
        <Property label="周期">
          <span className="text-sm text-ink-soft">
            {project.startDate ?? "?"} ~ {project.endDate ?? "?"}
          </span>
        </Property>
        <Property label="任务进度">
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-28 overflow-hidden rounded bg-sunken">
              <span
                className="block h-full rounded bg-primary transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="text-sm text-ink-soft">
              {taskDone}/{taskTotal} · {pct}%
            </span>
          </span>
        </Property>
        <Property label="成员">
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {members.slice(0, 4).map((m) => (
              <span key={m.id} className="ac-badge bg-sunken text-ink-soft">
                {m.name}
              </span>
            ))}
            {members.length > 4 && (
              <span className="text-xs text-ink-faint">+{members.length - 4}</span>
            )}
            {members.length === 0 && <span className="text-sm text-ink-faint">—</span>}
          </span>
        </Property>
        <Property label="里程碑">
          <span className="text-sm text-ink-soft">{milestoneCount} 个</span>
        </Property>
      </div>
      <p className="mt-3 border-t border-line pt-3 text-sm text-ink-soft">
        {project.description || "暂无项目描述"}
      </p>
    </section>
  );
}

/** Notion 属性行：左侧固定宽度的属性名 + 右侧值 */
function Property({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-ink-faint">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}
