import { describe, it, expect } from "vitest";
import {
  applyViewFilters,
  applyViewSorts,
  opsForKind,
  viewFieldMeta,
  type ViewFilterableTask,
  type ViewFilterContext,
} from "@/lib/board-filters";
import { normalizeConfig } from "@/lib/database-views";

const PROP_A = "aaaaaaaa-1111-1111-1111-111111111111"; // select 属性
const PROP_N = "aaaaaaaa-2222-2222-2222-222222222222"; // number 属性
const PROP_T = "aaaaaaaa-3333-3333-3333-333333333333"; // text 属性
const PROP_D = "aaaaaaaa-4444-4444-4444-444444444444"; // date 属性
const PROP_P = "aaaaaaaa-5555-5555-5555-555555555555"; // person 属性
const PROP_C = "aaaaaaaa-6666-6666-6666-666666666666"; // checkbox 属性
const PROP_M = "aaaaaaaa-7777-7777-7777-777777777777"; // multi_select 属性
const U1 = "bbbbbbbb-1111-1111-1111-111111111111";
const U2 = "bbbbbbbb-2222-2222-2222-222222222222";
const M1 = "cccccccc-1111-1111-1111-111111111111";
const M2 = "cccccccc-2222-2222-2222-222222222222";

const OPT_HIGH = "dddddddd-0000-0000-0000-000000000000";
const OPT_LOW = "dddddddd-1111-1111-1111-111111111111";

const CTX: ViewFilterContext = {
  defs: new Map([
    [PROP_A, { type: "select" as const, optionIds: [OPT_HIGH, OPT_LOW] }],
    [PROP_N, { type: "number" as const, optionIds: [] }],
    [PROP_T, { type: "text" as const, optionIds: [] }],
    [PROP_D, { type: "date" as const, optionIds: [] }],
    [PROP_P, { type: "person" as const, optionIds: [] }],
    [PROP_C, { type: "checkbox" as const, optionIds: [] }],
    [PROP_M, { type: "multi_select" as const, optionIds: [OPT_HIGH, OPT_LOW] }],
  ]),
  milestoneOrder: new Map([
    [M1, 0],
    [M2, 1],
  ]),
  members: new Map([
    [U1, "阿超"],
    [U2, "子龙"],
  ]),
};

function task(over: Partial<ViewFilterableTask> = {}): ViewFilterableTask {
  return {
    id: "t",
    title: "默认任务",
    status: "todo",
    priority: "medium",
    assigneeId: null,
    milestoneId: null,
    startDate: null,
    dueDate: null,
    labels: [],
    properties: {},
    sortOrder: 0,
    ...over,
  };
}

describe("viewFieldMeta", () => {
  it("原生字段与自定义属性映射到正确的类型档位", () => {
    expect(viewFieldMeta("title", CTX)?.kind).toBe("text");
    expect(viewFieldMeta("status", CTX)?.kind).toBe("enum");
    expect(viewFieldMeta("assignee", CTX)?.kind).toBe("person");
    expect(viewFieldMeta("label", CTX)?.kind).toBe("multi");
    expect(viewFieldMeta("dueDate", CTX)?.kind).toBe("date");
    expect(viewFieldMeta(`prop:${PROP_A}`, CTX)?.kind).toBe("select");
    expect(viewFieldMeta(`prop:${PROP_M}`, CTX)?.kind).toBe("multi");
    expect(viewFieldMeta(`prop:${PROP_C}`, CTX)?.kind).toBe("checkbox");
  });

  it("引用已删属性返回 null（子句将被忽略）", () => {
    expect(viewFieldMeta("prop:99999999-9999-9999-9999-999999999999", CTX)).toBeNull();
    expect(viewFieldMeta("galaxy" as never, CTX)).toBeNull();
  });

  it("各类型档位的操作符清单", () => {
    expect(opsForKind("text")).toContain("contains");
    expect(opsForKind("number")).toContain("gte");
    expect(opsForKind("checkbox")).toEqual(["isTrue", "isFalse"]);
    expect(opsForKind("enum")).toEqual(["in", "notIn"]);
    expect(opsForKind("date")).toContain("before");
  });
});

describe("applyViewFilters", () => {
  it("文本属性 contains / notContains / isEmpty / isNotEmpty", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_T]: "数据清洗" } }),
      task({ id: "2", properties: { [PROP_T]: "论文实验" } }),
      task({ id: "3", properties: {} }),
    ];
    const f = (op: string, value?: unknown) =>
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_T}`, op, value }], CTX).map(
        (t) => t.id,
      );
    expect(f("contains", "数据")).toEqual(["1"]);
    expect(f("notContains", "数据")).toEqual(["2", "3"]);
    expect(f("isEmpty")).toEqual(["3"]);
    expect(f("isNotEmpty")).toEqual(["1", "2"]);
  });

  it("任务标题 contains", () => {
    const tasks = [task({ id: "1", title: "部署服务器" }), task({ id: "2", title: "写论文" })];
    expect(
      applyViewFilters(tasks, [{ id: "c", field: "title", op: "contains", value: "服务器" }], CTX).map(
        (t) => t.id,
      ),
    ).toEqual(["1"]);
  });

  it("number 比较七连与空值", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_N]: 3 } }),
      task({ id: "2", properties: { [PROP_N]: 7.5 } }),
      task({ id: "3", properties: {} }),
    ];
    const f = (op: string, value?: unknown) =>
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_N}`, op, value }], CTX).map((t) => t.id);
    expect(f("eq", 3)).toEqual(["1"]);
    expect(f("ne", 3)).toEqual(["2", "3"]);
    expect(f("gt", 3)).toEqual(["2"]);
    expect(f("lte", 3)).toEqual(["1"]);
    expect(f("isEmpty")).toEqual(["3"]);
    expect(f("isNotEmpty")).toEqual(["1", "2"]);
    expect(f("gt", "abc")).toEqual(["1", "2", "3"]); // 非法值 → 子句忽略
  });

  it("select in / notIn / isEmpty；非法选项 id 不命中", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_A]: OPT_HIGH } }),
      task({ id: "2", properties: { [PROP_A]: OPT_LOW } }),
      task({ id: "3", properties: {} }),
    ];
    const f = (op: string, value?: unknown) =>
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_A}`, op, value }], CTX).map(
        (t) => t.id,
      );
    expect(f("in", [OPT_HIGH])).toEqual(["1"]);
    expect(f("in", [OPT_HIGH, OPT_LOW])).toEqual(["1", "2"]);
    expect(f("notIn", [OPT_HIGH])).toEqual(["2"]);
    expect(f("isEmpty")).toEqual(["3"]);
    expect(f("isNotEmpty")).toEqual(["1", "2"]);
    expect(f("in", ["eeeeeeee-1111-1111-1111-111111111111"])).toEqual([]);
  });

  it("multi_select hasAny / hasAll / isEmpty", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_M]: [OPT_HIGH] } }),
      task({ id: "2", properties: { [PROP_M]: [OPT_HIGH, OPT_LOW] } }),
      task({ id: "3", properties: {} }),
    ];
    const f = (op: string, value?: unknown) =>
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_M}`, op, value }], CTX).map(
        (t) => t.id,
      );
    expect(f("hasAny", [OPT_HIGH, "eeeeeeee-1111-1111-1111-111111111111"])).toEqual(["1", "2"]);
    expect(f("hasAll", [OPT_HIGH, OPT_LOW])).toEqual(["2"]);
    expect(f("isEmpty")).toEqual(["3"]);
  });

  it("日期 is / before / after / isEmpty", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_D]: "2026-11-01" } }),
      task({ id: "2", properties: { [PROP_D]: "2026-12-25" } }),
      task({ id: "3", properties: {} }),
    ];
    const f = (op: string, value?: unknown) =>
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_D}`, op, value }], CTX).map(
        (t) => t.id,
      );
    expect(f("is", "2026-11-01")).toEqual(["1"]);
    expect(f("before", "2026-12-01")).toEqual(["1"]);
    expect(f("after", "2026-12-01")).toEqual(["2"]);
    expect(f("isEmpty")).toEqual(["3"]);
    // 筛选层只做字符串比较（真实日校验在写入层），故月越界的字符串仍按字典序参与
    expect(f("before", "2026-13-01")).toEqual(["1", "2"]);
  });

  it("原生字段：状态 in、负责人 isEmpty/in、里程碑 isEmpty、标签 hasAny", () => {
    const tasks = [
      task({ id: "1", status: "done", assigneeId: U1, milestoneId: M1, labels: [{ id: "L1" }] }),
      task({ id: "2", status: "todo", assigneeId: U2 }),
      task({ id: "3", status: "doing" }),
    ];
    const run = (clause: object) =>
      applyViewFilters(tasks, [clause as never], CTX).map((t) => t.id);
    expect(run({ id: "c", field: "status", op: "in", value: ["done", "doing"] })).toEqual(["1", "3"]);
    expect(run({ id: "c", field: "status", op: "notIn", value: ["done"] })).toEqual(["2", "3"]);
    expect(run({ id: "c", field: "assignee", op: "isEmpty" })).toEqual(["3"]);
    expect(run({ id: "c", field: "assignee", op: "in", value: [U2] })).toEqual(["2"]);
    expect(run({ id: "c", field: "milestone", op: "isEmpty" })).toEqual(["2", "3"]);
    expect(run({ id: "c", field: "milestone", op: "in", value: [M1] })).toEqual(["1"]);
    expect(run({ id: "c", field: "label", op: "hasAny", value: ["L1"] })).toEqual(["1"]);
    expect(run({ id: "c", field: "label", op: "isEmpty" })).toEqual(["2", "3"]);
  });

  it("person 属性按团队成员 userId 筛选", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_P]: U1 } }),
      task({ id: "2", properties: {} }),
    ];
    expect(
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_P}`, op: "in", value: [U1] }], CTX).map(
        (t) => t.id,
      ),
    ).toEqual(["1"]);
    expect(
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_P}`, op: "isEmpty" }], CTX).map(
        (t) => t.id,
      ),
    ).toEqual(["2"]);
  });

  it("checkbox isTrue / isFalse（缺值=未勾选）", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_C]: true } }),
      task({ id: "2", properties: {} }),
    ];
    const run = (op: string) =>
      applyViewFilters(tasks, [{ id: "c", field: `prop:${PROP_C}`, op }], CTX).map((t) => t.id);
    expect(run("isTrue")).toEqual(["1"]);
    expect(run("isFalse")).toEqual(["2"]);
  });

  it("多子句取交集；失效字段子句恒真不筛行", () => {
    const tasks = [
      task({ id: "1", status: "todo", properties: { [PROP_N]: 1 } }),
      task({ id: "2", status: "done", properties: { [PROP_N]: 5 } }),
    ];
    expect(
      applyViewFilters(
        tasks,
        [
          { id: "a", field: "status", op: "in", value: ["todo"] },
          { id: "b", field: `prop:${PROP_N}`, op: "lt", value: 3 },
        ],
        CTX,
      ).map((t) => t.id),
    ).toEqual(["1"]);
    expect(
      applyViewFilters(tasks, [{ id: "x", field: `prop:${"99999999-9999-9999-9999-999999999999"}`, op: "in", value: ["x"] }], CTX),
    ).toHaveLength(2);
  });
});

describe("applyViewSorts", () => {
  it("number 排序（空值恒最后，与方向无关）", () => {
    const tasks = [
      task({ id: "empty", properties: {} }),
      task({ id: "b", properties: { [PROP_N]: 7 } }),
      task({ id: "a", properties: { [PROP_N]: 1 } }),
    ];
    const asc = applyViewSorts(tasks, [{ field: `prop:${PROP_N}`, dir: "asc" }], CTX).map((t) => t.id);
    expect(asc).toEqual(["a", "b", "empty"]);
    const desc = applyViewSorts(tasks, [{ field: `prop:${PROP_N}`, dir: "desc" }], CTX).map((t) => t.id);
    expect(desc).toEqual(["b", "a", "empty"]);
  });

  it("select 按选项定义顺序排（非字母序）", () => {
    const tasks = [
      task({ id: "low", properties: { [PROP_A]: OPT_LOW } }),
      task({ id: "high", properties: { [PROP_A]: OPT_HIGH } }),
    ];
    const sorted = applyViewSorts(tasks, [{ field: `prop:${PROP_A}`, dir: "asc" }], CTX).map(
      (t) => t.id,
    );
    expect(sorted).toEqual(["high", "low"]); // 选项序：OPT_HIGH 在前
  });

  it("原生枚举按任务口径排（status: todo→doing→done；priority: low→medium→high）", () => {
    const tasks = [
      task({ id: "done", status: "done" }),
      task({ id: "todo", status: "todo" }),
      task({ id: "doing", status: "doing" }),
    ];
    expect(applyViewSorts(tasks, [{ field: "status", dir: "asc" }], CTX).map((t) => t.id)).toEqual([
      "todo",
      "doing",
      "done",
    ]);
    const byPriority = applyViewSorts(
      [
        task({ id: "high", priority: "high" }),
        task({ id: "low", priority: "low" }),
        task({ id: "mid", priority: "medium" }),
      ],
      [{ field: "priority", dir: "desc" }],
      CTX,
    ).map((t) => t.id);
    expect(byPriority).toEqual(["high", "mid", "low"]);
  });

  it("milestone 按项目里程碑顺序，无里程碑恒最后", () => {
    const tasks = [
      task({ id: "none" }),
      task({ id: "m2", milestoneId: M2 }),
      task({ id: "m1", milestoneId: M1 }),
    ];
    expect(applyViewSorts(tasks, [{ field: "milestone", dir: "asc" }], CTX).map((t) => t.id)).toEqual([
      "m1",
      "m2",
      "none",
    ]);
  });

  it("person 按成员名排序；date 按日期字典序；文本 zh locale", () => {
    const people = [
      task({ id: "zilong", assigneeId: U2 }),
      task({ id: "achao", assigneeId: U1 }),
      task({ id: "none" }),
    ];
    expect(applyViewSorts(people, [{ field: "assignee", dir: "asc" }], CTX).map((t) => t.id)).toEqual([
      "achao",
      "zilong",
      "none",
    ]);
    const dates = [
      task({ id: "late", dueDate: "2026-12-01" }),
      task({ id: "early", dueDate: "2026-01-01" }),
    ];
    expect(applyViewSorts(dates, [{ field: "dueDate", dir: "asc" }], CTX).map((t) => t.id)).toEqual([
      "early",
      "late",
    ]);
    const texts = [
      task({ id: "b", title: "部署" }),
      task({ id: "a", title: "安全" }),
    ];
    expect(applyViewSorts(texts, [{ field: "title", dir: "asc" }], CTX).map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("两级排序：先主后次；平手回退 sortOrder", () => {
    const tasks = [
      task({ id: "x1", status: "todo", properties: { [PROP_N]: 9 }, sortOrder: 2 }),
      task({ id: "x2", status: "todo", properties: { [PROP_N]: 1 }, sortOrder: 1 }),
      task({ id: "y", status: "done", properties: { [PROP_N]: 5 }, sortOrder: 0 }),
    ];
    const sorted = applyViewSorts(
      tasks,
      [
        { field: "status", dir: "asc" },
        { field: `prop:${PROP_N}`, dir: "asc" },
      ],
      CTX,
    ).map((t) => t.id);
    expect(sorted).toEqual(["x2", "x1", "y"]);
    const tie = applyViewSorts(
      [
        task({ id: "later", sortOrder: 20 }),
        task({ id: "earlier", sortOrder: 10 }),
      ],
      [],
      CTX,
    );
    expect(tie.map((t) => t.id)).toEqual(["later", "earlier"]); // 无排序子句 → 保持原序
  });

  it("失效字段的排序子句被忽略", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" })];
    expect(
      applyViewSorts(tasks, [{ field: `prop:${"99999999-9999-9999-9999-999999999999"}`, dir: "asc" }], CTX).map(
        (t) => t.id,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("normalizeConfig 与筛选层的边界一致", () => {
  it("归一后的 filters/sorts 能直接喂给 applyViewFilters/applyViewSorts", () => {
    const config = normalizeConfig(
      {
        filters: [{ id: "f", field: `prop:${PROP_A}`, op: "in", value: [OPT_HIGH] }],
        sorts: [{ field: "dueDate", dir: "desc" }],
      },
      new Set([PROP_A]),
    );
    const tasks = [
      task({ id: "hit", properties: { [PROP_A]: OPT_HIGH }, dueDate: "2026-01-01" }),
      task({ id: "miss", properties: {} }),
    ];
    const filtered = applyViewFilters(tasks, config.filters ?? [], CTX);
    expect(filtered.map((t) => t.id)).toEqual(["hit"]);
    expect(applyViewSorts(filtered, config.sorts ?? [], CTX).map((t) => t.id)).toEqual(["hit"]);
  });
});
