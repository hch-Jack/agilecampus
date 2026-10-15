import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { getAiHistoryLimit, setAiHistoryLimit } from "@/lib/agent/memory";
import {
  AI_HISTORY_LIMIT_DEFAULT,
  AI_HISTORY_LIMIT_MAX,
  AI_HISTORY_LIMIT_MIN,
  normalizeAiHistoryLimit,
} from "@/lib/agent/history-limit";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

describe("助手记忆条数偏好（users.ai_history_limit）", () => {
  beforeEach(resetDb);

  it("新用户默认值即常量默认值", async () => {
    const user = await makeUser("student@example.com");
    expect(await getAiHistoryLimit(user.id)).toBe(AI_HISTORY_LIMIT_DEFAULT);
  });

  it("存进去什么就读回什么", async () => {
    const user = await makeUser("student@example.com");
    expect(await setAiHistoryLimit(user.id, 25)).toBe(25);
    expect(await getAiHistoryLimit(user.id)).toBe(25);
  });

  it("0 是合法值（= 不看历史），别被当成空值吃掉", async () => {
    const user = await makeUser("student@example.com");
    await setAiHistoryLimit(user.id, 0);
    expect(await getAiHistoryLimit(user.id)).toBe(0);
  });

  it("越界与非数字：钳制到端点 / 落回默认，且回传生效值", async () => {
    const user = await makeUser("student@example.com");

    expect(await setAiHistoryLimit(user.id, 999)).toBe(AI_HISTORY_LIMIT_MAX);
    expect(await setAiHistoryLimit(user.id, -3)).toBe(AI_HISTORY_LIMIT_MIN);
    expect(await setAiHistoryLimit(user.id, "abc")).toBe(AI_HISTORY_LIMIT_DEFAULT);
    // 小数截断（表单是 number 框，用户可能手敲 7.5）
    expect(await setAiHistoryLimit(user.id, "7.5")).toBe(7);
    // 字符串数字照收（FormData 给的就是字符串）
    expect(await setAiHistoryLimit(user.id, "20")).toBe(20);
    expect(await getAiHistoryLimit(user.id)).toBe(20);
  });

  it("只动自己那一行", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    await setAiHistoryLimit(a.id, 3);
    expect(await getAiHistoryLimit(a.id)).toBe(3);
    expect(await getAiHistoryLimit(b.id)).toBe(AI_HISTORY_LIMIT_DEFAULT);
  });
});

describe("normalizeAiHistoryLimit（纯函数）", () => {
  it.each([
    [0, 0],
    [50, 50],
    [51, 50],
    [-1, 0],
    [10.9, 10],
    ["12", 12],
    ["", AI_HISTORY_LIMIT_DEFAULT],
    ["abc", AI_HISTORY_LIMIT_DEFAULT],
    [NaN, AI_HISTORY_LIMIT_DEFAULT],
    [Infinity, AI_HISTORY_LIMIT_DEFAULT],
    [null, AI_HISTORY_LIMIT_DEFAULT],
    [undefined, AI_HISTORY_LIMIT_DEFAULT],
  ])("%p → %p", (input, expected) => {
    expect(normalizeAiHistoryLimit(input)).toBe(expected);
  });
});
