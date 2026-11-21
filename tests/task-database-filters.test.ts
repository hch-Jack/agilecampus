import { describe, it, expect } from "vitest";
import {
  applyDbFilters,
  parseDbFilters,
  serializeDbFilters,
  dbFieldMeta,
  opsForDbKind,
  type DbFilterableTask,
  type DbFilterContext,
} from "@/lib/task-database-filters";

const PROP_A = "aaaaaaaa-1111-1111-1111-111111111111"; // select
const PROP_N = "aaaaaaaa-2222-2222-2222-222222222222"; // number
const PROP_T = "aaaaaaaa-3333-3333-3333-333333333333"; // text
const PROP_D = "aaaaaaaa-4444-4444-4444-444444444444"; // date
const PROP_P = "aaaaaaaa-5555-5555-5555-555555555555"; // person
const PROP_C = "aaaaaaaa-6666-6666-6666-666666666666"; // checkbox
const PROP_M = "aaaaaaaa-7777-7777-7777-777777777777"; // multi_select
const U1 = "bbbbbbbb-1111-1111-1111-111111111111";
const M1 = "cccccccc-1111-1111-1111-111111111111";
const OPT_HIGH = "dddddddd-0000-0000-0000-000000000000";
const OPT_LOW = "dddddddd-1111-1111-1111-111111111111";

const CTX: DbFilterContext = {
  defs: new Map([
    [PROP_A, { type: "select" as const, optionIds: [OPT_HIGH, OPT_LOW] }],
    [PROP_N, { type: "number" as const, optionIds: [] }],
    [PROP_T, { type: "text" as const, optionIds: [] }],
    [PROP_D, { type: "date" as const, optionIds: [] }],
    [PROP_P, { type: "person" as const, optionIds: [] }],
    [PROP_C, { type: "checkbox" as const, optionIds: [] }],
    [PROP_M, { type: "multi_select" as const, optionIds: [OPT_HIGH, OPT_LOW] }],
  ]),
  milestoneOrder: new Map([[M1, 0]]),
  members: new Map([[U1, "阿超"]]),
};

function task(over: Partial<DbFilterableTask> = {}): DbFilterableTask {
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
    ...over,
  };
}

describe("URL 序列化往返", () => {
  it("parse(serialize(clauses)) 还原原句（含值）", () => {
    const clauses = [
      { field: "title", op: "contains", value: "部署" },
      { field: `prop:${PROP_N}`, op: "gt", value: 3 },
      { field: "status", op: "in", value: ["todo"] },
      { field: "dueDate", op: "isEmpty" },
    ];
    expect(parseDbFilters(serializeDbFilters(clauses))).toEqual(clauses);
  });

  it("空/垃圾输入返回空数组", () => {
    expect(parseDbFilters(null)).toEqual([]);
    expect(parseDbFilters("")).toEqual([]);
    expect(parseDbFilters("not-json")).toEqual([]);
    expect(parseDbFilters(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseDbFilters(JSON.stringify(["垃圾"]))).toEqual([]);
  });

  it("形状非法的子句被剔除，超上限截断", () => {
    expect(parseDbFilters(JSON.stringify([{ field: "", op: "in" }]))).toEqual([]);
    expect(parseDbFilters(JSON.stringify([{ field: "title", op: "" }]))).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ field: "title", op: "contains", value: String(i) }));
    expect(parseDbFilters(serializeDbFilters(many))).toHaveLength(10);
  });
});

describe("dbFieldMeta", () => {
  it("原生字段与自定义属性映射到正确档位；失效字段返回 null", () => {
    expect(dbFieldMeta("title", CTX)?.kind).toBe("text");
    expect(dbFieldMeta("status", CTX)?.kind).toBe("enum");
    expect(dbFieldMeta("assignee", CTX)?.kind).toBe("person");
    expect(dbFieldMeta("label", CTX)?.kind).toBe("multi");
    expect(dbFieldMeta(`prop:${PROP_A}`, CTX)?.kind).toBe("select");
    expect(dbFieldMeta(`prop:${PROP_M}`, CTX)?.kind).toBe("multi");
    expect(dbFieldMeta(`prop:${PROP_C}`, CTX)?.kind).toBe("checkbox");
    expect(dbFieldMeta("prop:99999999-9999-9999-9999-999999999999", CTX)).toBeNull();
    expect(dbFieldMeta("galaxy", CTX)).toBeNull();
  });

  it("各类型操作符清单", () => {
    expect(opsForDbKind("text")).toContain("contains");
    expect(opsForDbKind("checkbox")).toEqual(["isTrue", "isFalse"]);
    expect(opsForDbKind("enum")).toEqual(["in", "notIn"]);
    expect(opsForDbKind("date")).toContain("before");
  });
});

describe("applyDbFilters", () => {
  it("自定义属性：text/number/select/checkbox 操作符", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_T]: "数据清洗", [PROP_N]: 3, [PROP_A]: OPT_HIGH, [PROP_C]: true } }),
      task({ id: "2", properties: { [PROP_T]: "论文实验", [PROP_N]: 7.5, [PROP_A]: OPT_LOW } }),
      task({ id: "3", properties: {} }),
    ];
    const run = (clause: object) =>
      applyDbFilters(tasks, [clause as never], CTX).map((t) => t.id);
    expect(run({ field: `prop:${PROP_T}`, op: "contains", value: "数据" })).toEqual(["1"]);
    expect(run({ field: `prop:${PROP_T}`, op: "isEmpty" })).toEqual(["3"]);
    expect(run({ field: `prop:${PROP_N}`, op: "gte", value: 3 })).toEqual(["1", "2"]);
    expect(run({ field: `prop:${PROP_N}`, op: "lt", value: 5 })).toEqual(["1"]);
    expect(run({ field: `prop:${PROP_A}`, op: "in", value: [OPT_HIGH] })).toEqual(["1"]);
    expect(run({ field: `prop:${PROP_A}`, op: "isEmpty" })).toEqual(["3"]);
    expect(run({ field: `prop:${PROP_C}`, op: "isTrue" })).toEqual(["1"]);
    expect(run({ field: `prop:${PROP_C}`, op: "isFalse" })).toEqual(["2", "3"]);
    // 非法子句恒真
    expect(run({ field: `prop:${PROP_N}`, op: "gt", value: "abc" })).toEqual(["1", "2", "3"]);
    expect(run({ field: "prop:99999999-9999-9999-9999-999999999999", op: "in", value: ["x"] })).toHaveLength(3);
  });

  it("multi_select hasAny/hasAll/isEmpty", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_M]: [OPT_HIGH] } }),
      task({ id: "2", properties: { [PROP_M]: [OPT_HIGH, OPT_LOW] } }),
      task({ id: "3", properties: {} }),
    ];
    const run = (op: string, value?: unknown) =>
      applyDbFilters(tasks, [{ field: `prop:${PROP_M}`, op, value }], CTX).map((t) => t.id);
    expect(run("hasAny", [OPT_LOW])).toEqual(["2"]);
    expect(run("hasAll", [OPT_HIGH, OPT_LOW])).toEqual(["2"]);
    expect(run("isEmpty")).toEqual(["3"]);
  });

  it("date 属性 is/before/after/isEmpty", () => {
    const tasks = [
      task({ id: "1", properties: { [PROP_D]: "2026-11-01" } }),
      task({ id: "2", properties: { [PROP_D]: "2026-12-25" } }),
      task({ id: "3", properties: {} }),
    ];
    const run = (op: string, value?: unknown) =>
      applyDbFilters(tasks, [{ field: `prop:${PROP_D}`, op, value }], CTX).map((t) => t.id);
    expect(run("is", "2026-11-01")).toEqual(["1"]);
    expect(run("before", "2026-12-01")).toEqual(["1"]);
    expect(run("after", "2026-12-01")).toEqual(["2"]);
    expect(run("isEmpty")).toEqual(["3"]);
  });

  it("原生字段：标题包含/状态/负责人/里程碑/标签/截止日", () => {
    const tasks = [
      task({ id: "1", title: "部署服务器", status: "done", assigneeId: U1, milestoneId: M1, dueDate: "2026-11-01", labels: [{ id: "L1" }] }),
      task({ id: "2", status: "todo" }),
    ];
    const run = (clause: object) =>
      applyDbFilters(tasks, [clause as never], CTX).map((t) => t.id);
    expect(run({ field: "title", op: "contains", value: "服务器" })).toEqual(["1"]);
    expect(run({ field: "status", op: "in", value: ["done"] })).toEqual(["1"]);
    expect(run({ field: "assignee", op: "in", value: [U1] })).toEqual(["1"]);
    expect(run({ field: "assignee", op: "isEmpty" })).toEqual(["2"]);
    expect(run({ field: "milestone", op: "in", value: [M1] })).toEqual(["1"]);
    expect(run({ field: "label", op: "hasAny", value: ["L1"] })).toEqual(["1"]);
    expect(run({ field: "dueDate", op: "before", value: "2026-12-01" })).toEqual(["1"]);
  });

  it("多子句取交集；空子句列表原样返回", () => {
    const tasks = [
      task({ id: "1", status: "todo", properties: { [PROP_N]: 1 } }),
      task({ id: "2", status: "done", properties: { [PROP_N]: 5 } }),
    ];
    expect(
      applyDbFilters(
        tasks,
        [
          { field: "status", op: "in", value: ["todo"] },
          { field: `prop:${PROP_N}`, op: "lt", value: 3 },
        ],
        CTX,
      ).map((t) => t.id),
    ).toEqual(["1"]);
    expect(applyDbFilters(tasks, [], CTX)).toBe(tasks);
  });
});
