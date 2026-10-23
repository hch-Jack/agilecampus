import Link from "next/link";
import type {
  DashboardMessages,
  DashboardProject,
  DashboardTeam,
  DashboardUpcoming,
} from "../dashboard-types";
import { WidgetEmpty, WidgetShell } from "./shell";

const ROLE_LABEL: Record<DashboardTeam["role"], string> = {
  admin: "管理员",
  teacher: "老师",
  student: "学生",
};

export function MyProjectsWidget({ projects }: { projects: DashboardProject[] }) {
  return (
    <WidgetShell title="我的项目" href="/projects">
      {projects.length === 0 ? (
        <WidgetEmpty>还没有加入任何项目</WidgetEmpty>
      ) : (
        <ul className="space-y-2.5">
          {projects.slice(0, 8).map((project) => {
            const pct = project.taskTotal > 0 ? Math.round((project.doneCount / project.taskTotal) * 100) : 0;
            return (
              <li key={project.id}>
                <Link href={`/projects/${project.id}`} className="group block">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink group-hover:text-primary">
                      {project.name}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                      {project.doneCount}/{project.taskTotal}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-sunken">
                      <div className="h-full rounded-full bg-done" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="max-w-[45%] truncate text-[11px] text-ink-faint">
                      {project.teamName}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}

export function UpcomingWidget({
  tasks,
  today,
}: {
  tasks: DashboardUpcoming[];
  today: string;
}) {
  return (
    <WidgetShell title="即将到期">
      {tasks.length === 0 ? (
        <WidgetEmpty>没有待截止的任务</WidgetEmpty>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => {
            const overdue = task.dueDate < today;
            const dueToday = task.dueDate === today;
            return (
              <li key={task.id} className="text-sm">
                <Link
                  href={`/projects/${task.projectId}/tasks/${task.id}`}
                  className="line-clamp-2 font-medium text-ink hover:text-primary"
                >
                  {task.title}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
                  <span>{task.projectName}</span>
                  <span
                    className={
                      overdue
                        ? "ac-badge bg-high-soft text-high"
                        : dueToday
                          ? "ac-badge bg-medium-soft text-medium"
                          : "ac-badge bg-surface text-ink-soft"
                    }
                  >
                    {overdue ? `${task.dueDate} 逾期` : dueToday ? "今天截止" : task.dueDate}
                  </span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}

export function MyTeamsWidget({ teams }: { teams: DashboardTeam[] }) {
  return (
    <WidgetShell title="我的团队" href="/teams">
      {teams.length === 0 ? (
        <WidgetEmpty>还没有加入团队</WidgetEmpty>
      ) : (
        <ul className="space-y-2.5">
          {teams.slice(0, 8).map((team) => (
            <li key={team.id}>
              <Link
                href={`/teams/${team.id}/projects`}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="truncate font-medium text-ink hover:text-primary">{team.name}</span>
                <span className="ac-badge shrink-0 bg-primary-soft text-primary">
                  {ROLE_LABEL[team.role]}
                </span>
              </Link>
              <p className="mt-0.5 text-[11px] tabular-nums text-ink-faint">
                {team.counts.projects} 项目 · {team.counts.tasks} 任务 · {team.counts.members} 成员
              </p>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}

export function MessagesWidget({ messages }: { messages: DashboardMessages }) {
  const items = [
    { key: "dm", label: "私信", value: messages.dm },
    { key: "group", label: "群聊", value: messages.group },
    { key: "invites", label: "群邀请", value: messages.invites },
  ] as const;

  return (
    <WidgetShell title="消息" href="/messages" scroll={false}>
      <div className="grid grid-cols-3 gap-2">
        {items.map((item) => (
          <Link
            key={item.key}
            href="/messages"
            className="rounded-lg border border-line bg-surface px-2 py-2 text-center transition-colors hover:border-primary/50"
          >
            <p
              className={`font-display text-xl font-semibold tabular-nums ${
                item.value > 0 ? "text-high" : "text-ink"
              }`}
            >
              {item.value}
            </p>
            <p className="text-[11px] text-ink-faint">{item.label}</p>
          </Link>
        ))}
      </div>
    </WidgetShell>
  );
}

const QUICK_LINKS = [
  { href: "/projects", label: "项目", hint: "全部项目看板" },
  { href: "/teams", label: "团队", hint: "成员与资源" },
  { href: "/messages", label: "消息", hint: "私信与群聊" },
  { href: "/settings", label: "AI 设置", hint: "助手与偏好" },
] as const;

export function QuickLinksWidget() {
  return (
    <WidgetShell title="快捷入口" scroll={false}>
      <div className="grid grid-cols-2 gap-2">
        {QUICK_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-primary/50"
          >
            <p className="text-sm font-medium text-ink">{link.label}</p>
            <p className="truncate text-[11px] text-ink-faint">{link.hint}</p>
          </Link>
        ))}
      </div>
    </WidgetShell>
  );
}
