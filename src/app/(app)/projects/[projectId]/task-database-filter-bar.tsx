"use client";

// 任务数据库（只读总览表）的筛选条：与看板 FilterBar 同款的点选式 chips——
// 每个维度一排可点选的值（点「张三」只看张三的任务，再点取消），多选=任一命中。
// 条件写入 URL 的 dbf 参数（JSON 编码），与看板筛选参数共存同一条 URL（只动 dbf 键）。
import { useEffect, useMemo, useRef, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PRIORITY_TEXT, STATUS_TEXT } from "@/lib/task-constants";
import {
  EMPTY_DB_FILTERS,
  parseDbFilters,
  setDbFiltersOnParams,
  type DbFilters,
} from "@/lib/task-database-filters";

type Choice = { id: string; name: string; color?: string };

function Group({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-ink-soft">{name}</span>
      {children}
    </span>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        on
          ? "border-primary bg-primary-soft text-primary"
          : "border-line bg-surface text-ink-soft hover:border-primary/50 hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

export function TaskDatabaseFilterBar({
  defs,
  members,
  milestones,
  labels,
}: {
  defs: {
    id: string;
    name: string;
    type: string;
    options: { id: string; name: string; color: string }[] | null;
  }[];
  members: { id: string; name: string }[];
  milestones: { id: string; title: string }[];
  labels: { id: string; name: string; color: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const filters = useMemo(() => parseDbFilters(searchParams.get("dbf")), [searchParams]);
  // 连续快速点选时 URL 还没回来，下一次点击必须基于上一次的待提交值，否则会丢选中
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  function push(next: DbFilters) {
    // 只动 dbf 键；URLSearchParams 自己负责编码，别再 encodeURIComponent（双重编码会让筛选读不出来）
    filtersRef.current = next;
    const qs = setDbFiltersOnParams(searchParams, next).toString();
    // 服务端重渲染标成 transition：连续点多个 chips 时输入/按钮不被阻塞
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  const dirty =
    filters.status.length > 0 ||
    filters.assignee.length > 0 ||
    filters.priority.length > 0 ||
    filters.label.length > 0 ||
    filters.milestone.length > 0 ||
    filters.overdue ||
    Object.values(filters.props).some((v) => v.length > 0);

  const memberChoices = members.map((m) => ({ id: m.id, name: m.name }));
  const milestoneChoices = [
    ...milestones.map((m) => ({ id: m.id, name: m.title })),
    { id: "none", name: "无里程碑" },
  ];
  const statusChoices = (["todo", "doing", "done"] as const).map((s) => ({
    id: s,
    name: STATUS_TEXT[s] ?? s,
  }));
  const priorityChoices = (["high", "medium", "low"] as const).map((p) => ({
    id: p,
    name: PRIORITY_TEXT[p] ?? p,
  }));

  /** 点选自定义属性的一个值（toggle） */
  const toggleProp = (defId: string, value: string) => {
    const current = filtersRef.current;
    const cur = current.props[defId] ?? [];
    const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    const props = { ...current.props };
    if (next.length) props[defId] = next;
    else delete props[defId];
    push({ ...current, props });
  };

  const toggleValue = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  function PropGroup({
    def,
  }: {
    def: { id: string; name: string; type: string; options: { id: string; name: string; color: string }[] | null };
  }) {
    const values = filters.props[def.id] ?? [];
    if (def.type === "select") {
      const choices: Choice[] = [
        ...(def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })),
        { id: "none", name: "未设置" },
      ];
      if ((def.options ?? []).length === 0) return null;
      return (
        <Group name={def.name}>
          {choices.map((c) => (
            <Chip key={c.id} on={values.includes(c.id)} onClick={() => toggleProp(def.id, c.id)}>
              {c.name}
            </Chip>
          ))}
        </Group>
      );
    }
    if (def.type === "multi_select") {
      if ((def.options ?? []).length === 0) return null;
      return (
        <Group name={def.name}>
          {(def.options ?? []).map((o) => (
            <Chip key={o.id} on={values.includes(o.id)} onClick={() => toggleProp(def.id, o.id)}>
              {o.name}
            </Chip>
          ))}
        </Group>
      );
    }
    if (def.type === "person") {
      return (
        <Group name={def.name}>
          {[...memberChoices, { id: "none", name: "未设置" }].map((c) => (
            <Chip key={c.id} on={values.includes(c.id)} onClick={() => toggleProp(def.id, c.id)}>
              {c.name}
            </Chip>
          ))}
        </Group>
      );
    }
    if (def.type === "checkbox") {
      return (
        <Group name={def.name}>
          <Chip on={values.includes("checked")} onClick={() => toggleProp(def.id, "checked")}>
            已勾选
          </Chip>
          <Chip on={values.includes("unchecked")} onClick={() => toggleProp(def.id, "unchecked")}>
            未勾选
          </Chip>
        </Group>
      );
    }
    return null; // text/number/date 不做点选筛选
  }

  return (
    <div className="space-y-2 rounded-xl border border-line bg-sunken p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Group name="状态">
          {statusChoices.map((c) => (
            <Chip
              key={c.id}
              on={filters.status.includes(c.id)}
              onClick={() =>
                push({
                  ...filtersRef.current,
                  status: toggleValue(filtersRef.current.status, c.id),
                })
              }
            >
              {c.name}
            </Chip>
          ))}
        </Group>

        <Group name="负责人">
          {[...memberChoices, { id: "none", name: "未指派" }].map((m) => (
            <Chip
              key={m.id}
              on={filters.assignee.includes(m.id)}
              onClick={() =>
                push({
                  ...filtersRef.current,
                  assignee: toggleValue(filtersRef.current.assignee, m.id),
                })
              }
            >
              {m.name}
            </Chip>
          ))}
        </Group>

        <Group name="优先级">
          {priorityChoices.map((p) => (
            <Chip
              key={p.id}
              on={filters.priority.includes(p.id)}
              onClick={() =>
                push({
                  ...filtersRef.current,
                  priority: toggleValue(filtersRef.current.priority, p.id),
                })
              }
            >
              {p.name}
            </Chip>
          ))}
        </Group>

        {labels.length > 0 && (
          <Group name="标签">
            {labels.map((l) => (
              <Chip
                key={l.id}
                on={filters.label.includes(l.id)}
                onClick={() =>
                  push({
                    ...filtersRef.current,
                    label: toggleValue(filtersRef.current.label, l.id),
                  })
                }
              >
                {l.name}
              </Chip>
            ))}
          </Group>
        )}

        {milestones.length > 0 && (
          <Group name="里程碑">
            {milestoneChoices.map((m) => (
              <Chip
                key={m.id}
                on={filters.milestone.includes(m.id)}
                onClick={() =>
                  push({
                    ...filtersRef.current,
                    milestone: toggleValue(filtersRef.current.milestone, m.id),
                  })
                }
              >
                {m.name}
              </Chip>
            ))}
          </Group>
        )}

        <Chip
          on={filters.overdue}
          onClick={() =>
            push({
              ...filtersRef.current,
              overdue: !filtersRef.current.overdue,
            })
          }
        >
          仅看逾期
        </Chip>

        {dirty && (
          <button
            type="button"
            onClick={() => push(EMPTY_DB_FILTERS)}
            className="text-xs text-ink-faint hover:text-high"
          >
            清除筛选
          </button>
        )}
      </div>

      {defs.map((d) => (
        <PropGroup key={d.id} def={d} />
      ))}
    </div>
  );
}
