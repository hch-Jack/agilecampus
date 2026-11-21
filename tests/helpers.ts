import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function resetDb() {
  await db.execute(
    sql`TRUNCATE library_operations, library_source_links, library_versions, library_items, library_folders, libraries, document_locks, document_editors, document_versions, documents, approval_requests, system_messages, dm_messages, dm_group_messages, dm_group_invites, dm_group_members, dm_groups, dm_attachments, dm_contacts, task_plans, task_labels, labels, task_attachments, task_activities, agent_files, resource_usages, api_tokens, personal_contexts, skills, message_tags, task_dependencies, database_properties, project_views, messages, conversations, tasks, milestones, projects, team_members, teams, users RESTART IDENTITY CASCADE`,
  );
}
