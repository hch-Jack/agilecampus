import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { uploadAttachment } from "@/lib/attachment";

/**
 * 在线文档测试的共用夹具。
 *
 * 上传目录按文件隔离（与 blob-store.test.ts 同做法），避免测试产物落进仓库
 * 的 data/uploads，也让「失败保存是否残留 blob」可以靠文件清单精确断言。
 */

export async function makeUser(label: string) {
  return createUser({
    email: `${label}@example.com`,
    password: "password123",
    name: label,
  });
}

export type DocScene = {
  owner: Awaited<ReturnType<typeof makeUser>>;
  student: Awaited<ReturnType<typeof makeUser>>;
  teacher: Awaited<ReturnType<typeof makeUser>>;
  outsider: Awaited<ReturnType<typeof makeUser>>;
  team: Awaited<ReturnType<typeof createTeam>>;
  project: Awaited<ReturnType<typeof createProject>>;
  task: Awaited<ReturnType<typeof createTask>>;
};

/** admin + student + teacher + 非成员，一个项目一个任务 */
export async function makeDocScene(): Promise<DocScene> {
  const owner = await makeUser("owner");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student");
  await joinTeam(student.id, team.inviteCode);
  const teacher = await makeUser("teacher");
  await joinTeam(teacher.id, team.inviteCode);
  await updateMemberRole(owner.id, team.id, teacher.id, "teacher");
  const outsider = await makeUser("outsider");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  const task = await createTask(owner.id, project.id, { title: "撰写调研问卷" });
  return { owner, student, teacher, outsider, team, project, task };
}

export async function addTextAttachment(
  actorId: string,
  taskId: string,
  filename = "notes.txt",
  content = "第一版内容",
) {
  return uploadAttachment(actorId, taskId, {
    filename,
    mimeType: "text/plain",
    data: Buffer.from(content, "utf8"),
  });
}

let tempDir: string | null = null;
let prevUploadDir: string | undefined;

export async function setupTempUploadDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ac-docs-"));
  prevUploadDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = tempDir;
  return tempDir;
}

export async function teardownTempUploadDir(): Promise<void> {
  if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = prevUploadDir;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
}

const BLOB_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 当前上传目录里的 blob 文件（递归，过滤掉 2 位前缀目录） */
export async function listBlobFiles(): Promise<string[]> {
  if (!tempDir) throw new Error("先调用 setupTempUploadDir()");
  const entries = await readdir(tempDir, { recursive: true });
  return entries
    .filter((entry) => BLOB_FILE_RE.test(path.basename(entry)))
    .sort();
}
