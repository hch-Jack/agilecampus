import { describe, it, expect } from "vitest";
import { projectIdFromPathname } from "@/lib/project-path";

// 右侧助手面板靠 pathname 判断「用户此刻在看哪个项目」。这里只钉纯函数的边界：
// 认的必须是 /projects/<uuid> 这一种形状，其余一律不给 —— 把畸形 id 发给 /api/chat 只会换 400。
const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("projectIdFromPathname", () => {
  it("项目页与其子路由都取得到同一 id", () => {
    expect(projectIdFromPathname(`/projects/${ID}`)).toBe(ID);
    expect(projectIdFromPathname(`/projects/${ID}/`)).toBe(ID);
    expect(projectIdFromPathname(`/projects/${ID}/timeline`)).toBe(ID);
  });

  it("大写 uuid 也认（不强制小写）", () => {
    expect(projectIdFromPathname(`/projects/${ID.toUpperCase()}`)).toBe(ID.toUpperCase());
  });

  it("不是项目页的路径一律 null", () => {
    expect(projectIdFromPathname(null)).toBeNull();
    expect(projectIdFromPathname("/projects")).toBeNull();
    expect(projectIdFromPathname("/projects/")).toBeNull();
    expect(projectIdFromPathname("/teams/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toBeNull();
    expect(projectIdFromPathname("/dashboard")).toBeNull();
    expect(projectIdFromPathname("/settings")).toBeNull();
  });

  it("畸形 id 不往 API 送", () => {
    expect(projectIdFromPathname("/projects/not-a-uuid")).toBeNull();
    expect(projectIdFromPathname("/projects/6f1c2a3b-4d5e-4f60-8a7b")).toBeNull();
    // 前缀相同但不是 uuid 的路径段
    expect(projectIdFromPathname("/projects/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4bXYZ")).toBeNull();
  });
});
