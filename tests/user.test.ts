import { describe, it, expect, beforeEach } from "vitest";
import {
  createUser,
  detectAvatarMime,
  updateUserAvatar,
  updateUserPassword,
  updateUserProfile,
  userAvatarUrl,
} from "@/lib/user";
import { verifyPassword } from "@/lib/password";
import { AppError } from "@/lib/errors";
import { resetDb } from "./helpers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("createUser", () => {
  beforeEach(resetDb);

  it("创建用户并存哈希而非明文", async () => {
    const user = await createUser({
      email: "zhou@example.com",
      password: "password123",
      name: "周瑜",
    });
    expect(user.email).toBe("zhou@example.com");
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.passwordHash).not.toBe("password123");
    expect(await verifyPassword("password123", row.passwordHash)).toBe(true);
  });

  it("注册时填写的身份被持久化", async () => {
    const user = await createUser({
      email: "lusu@example.com",
      password: "password123",
      name: "鲁肃",
      identity: "teacher",
    });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.identity).toBe("teacher");
  });

  it("不传身份时存 NULL（存量调用方 / 飞书自动建号）", async () => {
    const user = await createUser({
      email: "passerby@example.com",
      password: "password123",
      name: "路人",
    });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.identity).toBeNull();
  });

  it("重复邮箱抛出可展示错误", async () => {
    await createUser({ email: "dup@example.com", password: "password123", name: "甲" });
    await expect(
      createUser({ email: "dup@example.com", password: "password123", name: "乙" }),
    ).rejects.toThrow("该邮箱已被注册");
  });

  it("并发注册同一邮箱：恰一个成功，另一个收到可展示的 AppError", async () => {
    const input = { email: "race@example.com", password: "password123", name: "并" };
    const results = await Promise.allSettled([createUser(input), createUser(input)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    expect(reason.message).toBe("该邮箱已被注册");
  });

  it("绕过查重的唯一键冲突（23505）被转译为可展示的 AppError", async () => {
    const email = "locked@example.com";
    let releaseTx!: () => void;
    const hold = new Promise<void>((r) => (releaseTx = r));
    let markInserted!: () => void;
    const inserted = new Promise<void>((r) => (markInserted = r));

    // 事务先插入同邮箱但不提交：createUser 的查重（读已提交）看不到该行，
    // 其 insert 将阻塞在唯一索引锁上；事务提交后必现 23505，
    // 从而确定性地覆盖「查重通过但唯一约束拦截」的竞态路径。
    const tx = db.transaction(async (trx) => {
      await trx.insert(users).values({ email, passwordHash: "x", name: "先" });
      markInserted();
      await hold;
    });

    await inserted;
    const pending = createUser({ email, password: "password123", name: "后" });
    pending.catch(() => {}); // 预挂 handler，消除拒绝早于断言挂接的瞬时 unhandled rejection
    await new Promise((r) => setTimeout(r, 300)); // 让 createUser 完成查重并阻塞于 insert
    releaseTx();
    await tx;

    await expect(pending).rejects.toBeInstanceOf(AppError);
    await expect(pending).rejects.toThrow("该邮箱已被注册");
  });

  it("邮箱统一转小写存储，大小写不同视为同一邮箱", async () => {
    const user = await createUser({
      email: "Zhou@Example.COM",
      password: "password123",
      name: "周瑜",
    });
    expect(user.email).toBe("zhou@example.com");
    await expect(
      createUser({ email: "ZHOU@example.com", password: "password123", name: "乙" }),
    ).rejects.toThrow("该邮箱已被注册");
  });

  it("用户名全站唯一：重名抛出可展示错误（私信按用户名找人依赖此约束）", async () => {
    await createUser({ email: "a@example.com", password: "password123", name: "周瑜" });
    await expect(
      createUser({ email: "b@example.com", password: "password123", name: "周瑜" }),
    ).rejects.toThrow("该用户名已被使用，请换一个");
  });

  it("用户名查重不区分大小写", async () => {
    await createUser({ email: "a@example.com", password: "password123", name: "ZhouYu" });
    await expect(
      createUser({ email: "b@example.com", password: "password123", name: "zhouyu" }),
    ).rejects.toThrow("该用户名已被使用，请换一个");
  });

  it("用户名入库前去首尾空白", async () => {
    const user = await createUser({ email: "a@example.com", password: "password123", name: "  周瑜  " });
    expect(user.name).toBe("周瑜");
  });

  it("绕过查重的用户名唯一键冲突被转译为可展示的 AppError", async () => {
    const name = "抢占";
    let releaseTx!: () => void;
    const hold = new Promise<void>((r) => (releaseTx = r));
    let markInserted!: () => void;
    const inserted = new Promise<void>((r) => (markInserted = r));

    // 事务先占住同名但不提交：createUser 的查重（读已提交）看不到该行，
    // 其 insert 阻塞在唯一索引锁上，提交后必现 23505
    const tx = db.transaction(async (trx) => {
      await trx.insert(users).values({ email: "hold@example.com", passwordHash: "x", name });
      markInserted();
      await hold;
    });

    await inserted;
    const pending = createUser({ email: "race@example.com", password: "password123", name });
    pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    releaseTx();
    await tx;

    await expect(pending).rejects.toBeInstanceOf(AppError);
    await expect(pending).rejects.toThrow("该用户名已被使用，请换一个");
  });
});

describe("updateUserProfile", () => {
  beforeEach(resetDb);

  it("改用户名与身份并返回新名字", async () => {
    const user = await createUser({ email: "p@example.com", password: "password123", name: "旧名" });
    const updated = await updateUserProfile(user.id, { name: "新名", identity: "student" });
    expect(updated.name).toBe("新名");
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.name).toBe("新名");
    expect(row.identity).toBe("student");
  });

  it("重名（不区分大小写）抛出可展示错误", async () => {
    await createUser({ email: "a@example.com", password: "password123", name: "ZhouYu" });
    const me = await createUser({ email: "b@example.com", password: "password123", name: "孙权" });
    await expect(
      updateUserProfile(me.id, { name: "zhouyu", identity: null }),
    ).rejects.toThrow("该用户名已被使用，请换一个");
  });

  it("保留自己的名字不算重名", async () => {
    const user = await createUser({ email: "keep@example.com", password: "password123", name: "周瑜" });
    const updated = await updateUserProfile(user.id, { name: "周瑜", identity: "teacher" });
    expect(updated.name).toBe("周瑜");
  });

  it("身份可清空为 NULL", async () => {
    const user = await createUser({
      email: "wipe@example.com",
      password: "password123",
      name: "甲",
      identity: "teacher",
    });
    await updateUserProfile(user.id, { name: "甲", identity: null });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.identity).toBeNull();
  });
});

describe("detectAvatarMime", () => {
  it("按魔数认出 PNG / JPEG / WebP", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectAvatarMime(png)).toBe("image/png");
    expect(detectAvatarMime(jpeg)).toBe("image/jpeg");
    expect(detectAvatarMime(webp)).toBe("image/webp");
  });

  it("伪造 file.type 救不了：字节不匹配即拒绝", () => {
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
    expect(detectAvatarMime(gif)).toBeNull();
    expect(detectAvatarMime(Uint8Array.from([0x89, 0x50]))).toBeNull(); // 太短
    expect(detectAvatarMime(new Uint8Array(0))).toBeNull();
  });
});

describe("updateUserAvatar", () => {
  beforeEach(resetDb);

  it("写入图片字节与 MIME，并盖上上传时刻", async () => {
    const user = await createUser({ email: "av@example.com", password: "password123", name: "甲" });
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await updateUserAvatar(user.id, data, "image/png");

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(Buffer.from(row.avatarData ?? new Uint8Array(0))).toEqual(data);
    expect(row.avatarMime).toBe("image/png");
    expect(row.avatarUpdatedAt).toBeInstanceOf(Date);
  });

  it("换头像即覆盖旧图（同一条记录，不留旧版本）", async () => {
    const user = await createUser({ email: "av2@example.com", password: "password123", name: "乙" });
    await updateUserAvatar(user.id, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    await updateUserAvatar(user.id, Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.avatarMime).toBe("image/jpeg");
    expect(Buffer.from(row.avatarData ?? new Uint8Array(0))).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );
  });

  it("userAvatarUrl：没传过头像返回 null，传过则带版本号", async () => {
    const user = await createUser({ email: "av3@example.com", password: "password123", name: "丙" });
    const [before] = await db.select().from(users).where(eq(users.id, user.id));
    expect(userAvatarUrl(user.id, before.avatarUpdatedAt)).toBeNull();

    await updateUserAvatar(user.id, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(userAvatarUrl(user.id, after.avatarUpdatedAt)).toBe(
      `/api/avatars/${user.id}?v=${after.avatarUpdatedAt!.getTime()}`,
    );
  });
});

describe("updateUserPassword", () => {
  beforeEach(resetDb);

  it("验过旧密码后改新密码", async () => {
    const user = await createUser({ email: "pw@example.com", password: "oldpass123", name: "甲" });
    await updateUserPassword(user.id, {
      currentPassword: "oldpass123",
      newPassword: "newpass456",
      requireCurrent: true,
    });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword("newpass456", row.passwordHash)).toBe(true);
    expect(await verifyPassword("oldpass123", row.passwordHash)).toBe(false);
  });

  it("旧密码错误抛出可展示错误", async () => {
    const user = await createUser({ email: "wrong@example.com", password: "oldpass123", name: "甲" });
    await expect(
      updateUserPassword(user.id, {
        currentPassword: "wrongpass",
        newPassword: "newpass456",
        requireCurrent: true,
      }),
    ).rejects.toThrow("当前密码不正确");
  });

  it("requireCurrent=false 免验旧密码（飞书专用账号的占位密码本人无从得知）", async () => {
    const user = await createUser({ email: "f@example.com", password: "password123", name: "甲" });
    await updateUserPassword(user.id, {
      currentPassword: "",
      newPassword: "setpass456",
      requireCurrent: false,
    });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword("setpass456", row.passwordHash)).toBe(true);
  });
});
