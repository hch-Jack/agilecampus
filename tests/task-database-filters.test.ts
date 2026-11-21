import { describe, it, expect } from "vitest";
import {
  applyDbFilters,
  parseDbFilters,
  serializeDbFilters,
  EMPTY_DB_FILTERS,
  type DbFilterableTask,
  type DbFilterContext,
} from "@/lib/task-database-filters";

const PROP_A = "aaaaaaaa-1111-1111-1111-111111111111"; // select
const PROP_M = "aaaaaaaa-2222-2222-2222-222222222222"; // multi_select
const PROP_P = "aaaaaaaa-3333-3333-3333-333333333333"; // person
const PROP_C = "aaaaaaaa-4444-4444-4444-444444444444"; // checkbox
const PROP_T = "aaaaaaaa-5555-5555-5555-555555555555"; // text（不做点选筛选）
const U1 = "bbbbbbbb-1111-1111-1111-111111111111";
const M1 = "cccccccc-1111-1111-1111-111111111111";
const OPT_HIGH = "dddddddd-0000-0000-0000-000000000000";
const OPT_LOW = "dddddddd-1111-1111-1111-111111111111";
const TODAY = "2026-11-21";

const CTX: DbFilterContext = {
  defs: new Map([
    [PROP_A, { type: "select" as const, optionIds: [OPT_HIGH, OPT_LOW] }],
    [PROP_M, { type: "multi_select" as const, optionIds: [OPT_HIGH, OPT_LOW] }],
    [PROP_P, { type: "person" as const, optionIds: [] }],
    [PROP_C, { type: "checkbox" as const, optionIds: [] }],
    [PROP_T, { type: "text" as const, optionIds: [] }],
  ]),
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
  it("parse(serialize(f)) 还原筛选态", () => {
    const f = {
      status: ["todo"],
      assignee: [U1, "none"],
      priority: ["high"],
      label: ["11111111-1111-1111-1111-111111111111"],
      milestone: [M1],
      overdue: true,
      props: { [PROP_A]: [OPT_HIGH, "none"], [PROP_C]: ["checked"] },
    };
    expect(parseDbFilters(serializeDbFilters(f))).toEqual(f);
  });

  it("空态序列化为空串，垃圾输入还原为空态", () => {
    expect(serializeDbFilters(EMPTY_DB_FILTERS)).toBe("");
    expect(parseDbFilters(null)).toEqual(EMPTY_DB_FILTERS);
    expect(parseDbFilters("not-json")).toEqual(EMPTY_DB_FILTERS);
    expect(parseDbFilters(JSON.stringify({ a: 1 }))).toEqual(EMPTY_DB_FILTERS);
  });

  it("非法值逐项剔除：非法枚举/非法 uuid/非法 prop 键都不进结果", () => {
    const parsed = parseDbFilters(
      JSON.stringify({
        status: ["todo", "galaxy"],
        assignee: [U1, "不是id"],
        priority: ["high", "urgent"],
        label: ["不是id"],
        milestone: [M1, "nope"],
        overdue: "yes",
        props: { "不是uuid": [OPT_HIGH], [PROP_A]: [OPT_HIGH, "垃圾", OPT_LOW] },
      }),
    );
    expect(parsed.status).toEqual(["todo"]);
    expect(parsed.assignee).toEqual([U1]);
    expect(parsed.priority).toEqual(["high"]);
    expect(parsed.label).toEqual([]);
    expect(parsed.milestone).toEqual([M1]);
    expect(parsed.overdue).toBe(false);
    expect(parsed.props[PROP_A]).toEqual([OPT_HIGH, OPT_LOW]);
    expect(Object.keys(parsed.props)).not.toContain("不是uuid");
  });
});

describe("applyDbFilters", () => {
  it("原生维度：状态/负责人（含未指派）/优先级任一命中", () => {
    const tasks = [
      task({ id: "1", status: "done", assigneeId: U1, priority: "high" }),
      task({ id: "2", status: "todo", priority: "low" }),
      task({ id: "3", status: "doing" }),
    ];
    const run = (over: Partial<typeof EMPTY_DB_FILTERS>) =>
      applyDbFilters(tasks, { ...EMPTY_DB_FILTERS, ...over }, CTX, TODAY).map((t) => t.id);
    expect(run({ status: ["todo", "doing"] })).toEqual(["2", "3"]);
    expect(run({ assignee: [U1] })).toEqual(["1"]);
    expect(run({ assignee: ["none"] })).toEqual(["2", "3"]);
    expect(run({ priority: ["high", "low"] })).toEqual(["1", "2"]);
    expect(run({})).toEqual(["1", "2", "3"]);
  });

  it("标签与里程碑（含无里程碑）", () => {
    const tasks = [
      task({ id: "1", milestoneId: M1, labels: [{ id: "L1" }] }),
      task({ id: "2" }),
    ];
    const run = (over: Partial<typeof EMPTY_DB_FILTERS>) =>
      applyDbFilters(tasks, { ...EMPTY_DB_FILTERS, ...over }, CTX, TODAY).map((t) => t.id);
    expect(run({ label: ["L1"] })).toEqual(["1"]);
    expect(run({ milestone: [M1] })).toEqual(["1"]);
    expect(run({ milestone: ["none"] })).toEqual(["2"]);
  });

  it("仅看逾期：有截止日 < 今天 且未完成（today 由调用方传入）", () => {
    const tasks = [
      task({ id: "overdue", dueDate: "2026-11-20" }),
      task({ id: "future", dueDate: "2026-12-01" }),
      task({ id: "doneOk", dueDate: "2026-11-20", status: "done" }),
      task({ id: "noDue" }),
    ];
    const filtered = applyDbFilters(
      tasks,
      { ...EMPTY_DB_FILTERS, overdue: true },
      CTX,
      TODAY,
    ).map((t) => t.id);
    expect(filtered).toEqual(["overdue"]);
  });

  it("自定义属性：单选（含未设置）/多选（任一含未设置）/人员/checkbox", () => {
    const tasks = [
      task({ id: "1", assigneeId: U1, properties: { [PROP_A]: OPT_HIGH, [PROP_M]: [OPT_HIGH], [PROP_P]: U1, [PROP_C]: true } }),
      task({ id: "2", properties: { [PROP_A]: OPT_LOW, [PROP_M]: [], [PROP_C]: false } }),
      task({ id: "3", properties: {} }),
    ];
    const run = (over: Partial<typeof EMPTY_DB_FILTERS>) =>
      applyDbFilters(tasks, { ...EMPTY_DB_FILTERS, ...over }, CTX, TODAY).map((t) => t.id);
    // 单选
    expect(run({ props: { [PROP_A]: [OPT_HIGH] } })).toEqual(["1"]);
    expect(run({ props: { [PROP_A]: ["none"] } })).toEqual(["3"]);
    expect(run({ props: { [PROP_A]: [OPT_LOW, OPT_HIGH] } })).toEqual(["1", "2"]);
    // 多选：任一命中（无任务含 OPT_LOW → 空结果）；「未设置」= 空数组/无值
    expect(run({ props: { [PROP_M]: [OPT_LOW] } })).toEqual([]);
    expect(run({ props: { [PROP_M]: [OPT_HIGH] } })).toEqual(["1"]);
    expect(run({ props: { [PROP_M]: ["none"] } })).toEqual(["2", "3"]); // 空数组也算未设置
    // 人员
    expect(run({ props: { [PROP_P]: [U1] } })).toEqual(["1"]);
    expect(run({ props: { [PROP_P]: ["none"] } })).toEqual(["2", "3"]);
    // checkbox
    expect(run({ props: { [PROP_C]: ["checked"] } })).toEqual(["1"]);
    expect(run({ props: { [PROP_C]: ["unchecked"] } })).toEqual(["2", "3"]);
  });

  it("多维度取交集；已删属性维度忽略；text 属性维度不筛", () => {
    const tasks = [
      task({ id: "1", status: "todo", properties: { [PROP_A]: OPT_HIGH, [PROP_T]: "x" } }),
      task({ id: "2", status: "done", properties: { [PROP_A]: OPT_LOW, [PROP_T]: "y" } }),
    ];
    expect(
      applyDbFilters(
        tasks,
        { ...EMPTY_DB_FILTERS, status: ["todo"], props: { [PROP_A]: [OPT_HIGH] } },
        CTX,
        TODAY,
      ).map((t) => t.id),
    ).toEqual(["1"]);
    expect(
      applyDbFilters(
        tasks,
        { ...EMPTY_DB_FILTERS, props: { ["99999999-9999-9999-9999-999999999999"]: [OPT_HIGH] } },
        CTX,
        TODAY,
      ).map((t) => t.id),
    ).toEqual(["1", "2"]);
    expect(
      applyDbFilters(tasks, { ...EMPTY_DB_FILTERS, props: { [PROP_T]: ["x"] } }, CTX, TODAY).map(
        (t) => t.id,
      ),
    ).toEqual(["1", "2"]);
  });
});
