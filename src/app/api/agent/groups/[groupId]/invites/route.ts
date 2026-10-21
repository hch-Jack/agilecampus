import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { inviteToGroupMembers } from "@/lib/group-chat";

type Ctx = { params: Promise<{ groupId: string }> };

const schema = z
  .object({
    usernames: z.array(z.string()).optional(),
    username: z.string().optional(),
  })
  .refine(
    (d) =>
      (Array.isArray(d.usernames) && d.usernames.length > 0) ||
      (typeof d.username === "string" && d.username.trim() !== ""),
    { message: "请给出要邀请的用户名（username 或 usernames）" },
  );

/**
 * POST /api/agent/groups/{groupId}/invites — 邀请一个或多个人进群。
 * 与网页一致：邀请进入待处理列表，**对方接受后才入群**（不是直接拉人）。
 * 调用者须仍在群聊里；已在群里 / 已邀请过 / 群满都会返回 400。
 */
export async function POST(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const parsedGroupId = z.uuid().safeParse((await ctx.params).groupId);
  if (!parsedGroupId.success) {
    return NextResponse.json({ error: "groupId 无效" }, { status: 400 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const usernames =
    parsed.data.usernames && parsed.data.usernames.length > 0
      ? parsed.data.usernames
      : [parsed.data.username!];

  try {
    const result = await inviteToGroupMembers(userId, parsedGroupId.data, usernames);
    return NextResponse.json({
      invited: result.invitees.length,
      groupName: result.groupName,
      invitees: result.invitees.map((i) => ({ userId: i.id, name: i.name })),
    });
  } catch (e) {
    return mapAgentError(e, "[POST /api/agent/groups/:groupId/invites]");
  }
}
