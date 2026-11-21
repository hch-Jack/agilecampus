"use client";

// 任务数据库（只读总览表）的筛选条：与看板 FilterBar 同款的点选式 chips——
// 每个维度一排可点选的值（点「张三」只看张三的任务，再点取消），多选=任一命中。
// 条件写入 URL 的 dbf 参数（JSON 编码），与看板筛选参数共存同一条 URL（只动 dbf 键）。
import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PRIORITY_TEXT, STATUS_TEXT } from "@/lib/task-constants";
import {
  EMPTY_DB_FILTERS,
  parseDbFilters,
  serializeDbFilters,
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
  const filters = useMemo(() => parseDbFilters(searchParams.get("dbf")), [searchParams]);

  function push(next: DbFilters) {
    const params = new URLSearchParams(searchParams.toString());
    const serialized = serializeDbFilters(next);
    if (serialized) params.set("dbf", encodeURIComponent(serialized));
    else params.delete("dbf");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
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
    const cur = filters.props[defId] ?? [];
    const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    const props = { ...filters.props };
    if (next.length) props[defId] = next;
    else delete props[defId];
    push({ ...filters, props });
  };

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
                  ...filters,
                  status: filters.status.includes(c.id)
                    ? filters.status.filter((x) => x !== c.id)
                    : [...filters.status, c.id],
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
                  ...filters,
                  assignee: filters.assignee.includes(m.id)
                    ? filters.assignee.filter((x) => x !== m.id)
                    : [...filters.assignee, m.id],
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
                  ...filters,
                  priority: filters.priority.includes(p.id)
                    ? filters.priority.filter((x) => x !== p.id)
                    : [...filters.priority, p.id],
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
                    ...filters,
                    label: filters.label.includes(l.id)
                      ? filters.label.filter((x) => x !== l.id)
                      : [...filters.label, l.id],
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
                    ...filters,
                    milestone: filters.milestone.includes(m.id)
                      ? filters.milestone.filter((x) => x !== m.id)
                      : [...filters.milestone, m.id],
                  })
                }
              >
                {m.name}
              </Chip>
            ))}
          </Group>
        )}

        <Chip on={filters.overdue} onClick={() => push({ ...filters, overdue: !filters.overdue })}>
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
