import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { tasks, users, teams, teamMembers, projects } from "@/db/schema";
import { listTaskComments, createTaskComment, deleteTaskComment } from "@/lib/comment";
import { resetDb } from "./helpers";
import { ForbiddenError } from "@/lib/errors";

describe("Task Comments (留言板)", () => {
  beforeEach(resetDb);

  it("team members can list, create, and delete task comments", async () => {
    const [u1] = await db.insert(users).values({ email: "u1@test.com", passwordHash: "x", name: "Alice" }).returning();
    const [u2] = await db.insert(users).values({ email: "u2@test.com", passwordHash: "x", name: "Bob" }).returning();
    const [team] = await db.insert(teams).values({ name: "Lab", inviteCode: "123456" }).returning();
    await db.insert(teamMembers).values([
      { teamId: team.id, userId: u1.id, role: "admin" },
      { teamId: team.id, userId: u2.id, role: "student" },
    ]);
    const [proj] = await db.insert(projects).values({ teamId: team.id, name: "Research Project" }).returning();
    const [task] = await db.insert(tasks).values({ projectId: proj.id, title: "Task 1" }).returning();

    // Initially empty
    const commentsBefore = await listTaskComments(u1.id, task.id);
    expect(commentsBefore).toHaveLength(0);

    // Create comment
    const comment = await createTaskComment(u1.id, task.id, "Hello team!");
    expect(comment.content).toBe("Hello team!");
    expect(comment.authorId).toBe(u1.id);

    // List comments
    const commentsAfter = await listTaskComments(u2.id, task.id);
    expect(commentsAfter).toHaveLength(1);
    expect(commentsAfter[0].content).toBe("Hello team!");
    expect(commentsAfter[0].authorName).toBe("Alice");

    // Non-author student cannot delete Alice's comment
    await expect(deleteTaskComment(u2.id, comment.id)).rejects.toThrow(ForbiddenError);

    // Author can delete their own comment
    await deleteTaskComment(u1.id, comment.id);
    expect(await listTaskComments(u1.id, task.id)).toHaveLength(0);
  });
});
