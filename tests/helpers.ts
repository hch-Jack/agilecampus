import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function resetDb() {
  await db.execute(
    sql`TRUNCATE dm_messages, dm_group_messages, dm_group_invites, dm_group_members, dm_groups, dm_attachments, dm_contacts, task_plans, task_labels, labels, task_attachments, task_activities, resource_usages, api_tokens, personal_contexts, task_dependencies, messages, conversations, tasks, milestones, projects, team_members, teams, users RESTART IDENTITY CASCADE`,
  );
}
