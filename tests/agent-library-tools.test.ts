import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { libraryFolders, libraryItems, taskAttachments } from "@/db/schema";
import { buildPersonalTools, CREATE_LIBRARY_FOLDER_TOOL, SEND_MESSAGE_TOOL } from "@/lib/agent/tools";
import { commitPersonalDraft } from "@/lib/agent/commit";
import { copyLibraryItemToAgentFile } from "@/lib/agent/library";
import { readAgentFileText } from "@/lib/agent/files";
import { listDmMessagesReadOnly } from "@/lib/dm";
import { uploadToLibrary } from "@/lib/library/upload";
import { ensureLibrary } from "@/lib/library/folders";
import { resetDb } from "./helpers";
import { addAgentFile } from "./library-helpers";
import {
  makeDocScene,
  setupTempUploadDir,
  teardownTempUploadDir,
} from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const opts = {} as never;

function streamOf(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function envelope(out: unknown) {
  return out as { __draft: true; tool: string; draft: Record<string, unknown> };
}

const personalRef = (userId: string) => ({ kind: "personal" as const, userId });

async function seedPersonalFile(
  userId: string,
  filename: string,
  content: string,
) {
  const res = await uploadToLibrary(userId, personalRef(userId), {
    folderId: null,
    filename,
    mimeType: "text/plain",
    stream: streamOf(content),
  });
  return res.itemId;
}

describe("工作台助手：资源库读能力", () => {
  it("浏览 / 搜索 / 读正文 / 预览都能按库权限命中", async () => {
    const s = await makeDocScene();
    const itemId = await seedPersonalFile(s.student.id, "课程笔记.txt", "第一节课：线性代数");
    const tools = buildPersonalTools(s.student.id);

    const viewed = (await tools.browse_library.execute!(
      { scope: "personal" as const },
      opts,
    )) as {
      items: { itemId: string; filename: string; folderPath: string }[];
      library: { label: string };
    };
    expect(viewed.library.label).toBe("个人资源库");
    expect(viewed.items.map((i) => i.filename)).toContain("课程笔记.txt");

    const found = (await tools.search_library.execute!(
      { query: "课程", scope: "all" as const },
      opts,
    )) as { items: { itemId: string; libraryLabel: string }[] };
    expect(found.items.map((i) => i.itemId)).toContain(itemId);
    expect(found.items[0].libraryLabel).toBe("个人资源库");

    const text = (await tools.read_library_file.execute!({ itemId }, opts)) as {
      text?: string;
      note?: string;
    };
    expect(text.text).toContain("线性代数");

    const open = (await tools.open_library_file.execute!({ itemId }, opts)) as {
      __showFile: true;
      url: string;
      filename: string;
    };
    expect(open.__showFile).toBe(true);
    expect(open.url).toBe(`/api/library/items/${itemId}/content`);
    expect(open.filename).toBe("课程笔记.txt");

    // 面板「从资源库选择」：库文件登记成 assistant 文件后，按普通附件读正文
    const attached = await copyLibraryItemToAgentFile(s.student.id, itemId);
    const attachedText = await readAgentFileText(s.student.id, attached.id);
    expect(attachedText.filename).toBe("课程笔记.txt");
    expect(attachedText.text).toContain("线性代数");

    // 别人的个人库文件：文件存在但无权读，一律「不存在或没有访问权限」
    const outsiderTools = buildPersonalTools(s.outsider.id);
    await expect(
      outsiderTools.read_library_file.execute!({ itemId }, opts),
    ).rejects.toThrow("访问权限");
  });

  it("团队库按角色收敛：成员可看，非成员被拒", async () => {
    const s = await makeDocScene();
    await uploadToLibrary(s.owner.id, { kind: "team", teamId: s.team.id }, {
      folderId: null,
      filename: "组会纪要.md",
      mimeType: "text/markdown",
      stream: streamOf("# 组会"),
    });

    const studentTools = buildPersonalTools(s.student.id);
    const viewed = (await studentTools.browse_library.execute!(
      { scope: "team" as const, teamId: s.team.id },
      opts,
    )) as { items: { filename: string }[] };
    expect(viewed.items.map((i) => i.filename)).toContain("组会纪要.md");

    const outsiderTools = buildPersonalTools(s.outsider.id);
    await expect(
      outsiderTools.browse_library.execute!(
        { scope: "team" as const, teamId: s.team.id },
        opts,
      ),
    ).rejects.toThrow();
  });
});

describe("工作台助手：资源库写能力（草案 → 确认落库）", () => {
  it("新建 / 改名 / 删除文件夹：拟稿不落库，确认后才生效", async () => {
    const s = await makeDocScene();
    const tools = buildPersonalTools(s.student.id);
    const library = await ensureLibrary(personalRef(s.student.id));

    const created = envelope(
      await tools.create_library_folder.execute!(
        { scope: "personal" as const, name: "课程资料" },
        opts,
      ),
    );
    expect(created).toMatchObject({
      __draft: true,
      tool: CREATE_LIBRARY_FOLDER_TOOL,
      draft: { name: "课程资料" },
    });
    expect(
      await db.select().from(libraryFolders).where(eq(libraryFolders.libraryId, library.id)),
    ).not.toContainEqual(expect.objectContaining({ name: "课程资料" }));

    await commitPersonalDraft(s.student.id, CREATE_LIBRARY_FOLDER_TOOL, created.draft);
    const [folder] = await db
      .select()
      .from(libraryFolders)
      .where(
        and(eq(libraryFolders.libraryId, library.id), eq(libraryFolders.name, "课程资料")),
      );
    expect(folder).toBeTruthy();

    const renamed = envelope(
      await tools.rename_library_folder.execute!(
        { folderId: folder.id, name: "课程归档" },
        opts,
      ),
    );
    await commitPersonalDraft(s.student.id, "rename_library_folder", renamed.draft);
    const [afterRename] = await db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.id, folder.id));
    expect(afterRename.name).toBe("课程归档");

    const deleted = envelope(
      await tools.delete_library_folder.execute!(
        { folderId: folder.id, mode: "keep-files" as const },
        opts,
      ),
    );
    await commitPersonalDraft(s.student.id, "delete_library_folder", deleted.draft);
    expect(
      await db.select().from(libraryFolders).where(eq(libraryFolders.id, folder.id)),
    ).toHaveLength(0);
  });

  it("保存助手文件进资源库 → 复制 / 改名 / 移动 / 进任务 / 发消息 / 恢复版本", async () => {
    const s = await makeDocScene();
    const tools = buildPersonalTools(s.student.id);
    const file = await addAgentFile(s.student.id, "周报.txt", "第一版周报");

    const saved = envelope(
      await tools.save_file_to_library.execute!(
        { fileId: file.id, scope: "personal" as const, filename: "周报存档.txt" },
        opts,
      ),
    );
    await commitPersonalDraft(s.student.id, "save_file_to_library", saved.draft);

    const library = await ensureLibrary(personalRef(s.student.id));
    const [item] = await db
      .select()
      .from(libraryItems)
      .where(
        and(eq(libraryItems.libraryId, library.id), eq(libraryItems.filename, "周报存档.txt")),
      );
    expect(item).toBeTruthy();
    expect(item.origin).toBe("agent");

    // 复制一份（换名），源文件不动
    const copied = envelope(
      await tools.copy_library_file.execute!(
        {
          itemId: item.id,
          scope: "personal" as const,
          folderId: null,
          filename: "周报副本.txt",
        },
        opts,
      ),
    );
    await commitPersonalDraft(s.student.id, "copy_library_file", copied.draft);
    const copies = await db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.libraryId, library.id));
    expect(copies.map((c) => c.filename).sort()).toEqual(["周报副本.txt", "周报存档.txt"]);

    // 资源库文件 → 任务附件
    const toTask = envelope(
      await tools.save_library_file_to_task.execute!(
        { itemId: item.id, taskId: s.task.id },
        opts,
      ),
    );
    await commitPersonalDraft(s.student.id, "save_library_file_to_task", toTask.draft);
    const attachments = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.taskId, s.task.id));
    expect(attachments.some((a) => a.filename === "周报存档.txt")).toBe(true);

    // 资源库文件发给别人（send_message 的第四种文件来源）
    const sent = envelope(
      await tools.send_message.execute!(
        {
          targetType: "user" as const,
          targetId: s.owner.id,
          content: "周报发你",
          fileSource: "library" as const,
          attachmentId: item.id,
        },
        opts,
      ),
    );
    expect(sent.tool).toBe(SEND_MESSAGE_TOOL);
    await commitPersonalDraft(s.student.id, SEND_MESSAGE_TOOL, sent.draft);
    const thread = await listDmMessagesReadOnly(s.owner.id, s.student.id, 10);
    expect(thread.messages.some((m) => m.attachment?.filename === "周报存档.txt")).toBe(true);

    // 追加 v2 后恢复到 v1：新版本号是 v3，内容回到第一版
    await uploadToLibrary(s.student.id, personalRef(s.student.id), {
      folderId: null,
      filename: "周报存档.txt",
      mimeType: "text/plain",
      stream: streamOf("第二版周报"),
    });
    const history = (await tools.list_library_versions.execute!(
      { itemId: item.id },
      opts,
    )) as { currentVersion: number; versions: { version: number }[] };
    expect(history.currentVersion).toBe(2);

    const restored = envelope(
      await tools.restore_library_version.execute!(
        { itemId: item.id, version: 1 },
        opts,
      ),
    );
    await commitPersonalDraft(s.student.id, "restore_library_version", restored.draft);
    const [afterRestore] = await db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.id, item.id));
    expect(afterRestore.currentVersion).toBe(3);
  });

  it("只读教师不能对团队库拟写草案", async () => {
    const s = await makeDocScene();
    const teacherTools = buildPersonalTools(s.teacher.id);
    await expect(
      teacherTools.create_library_folder.execute!(
        { scope: "team" as const, teamId: s.team.id, name: "越权" },
        opts,
      ),
    ).rejects.toThrow("编辑权限");
  });
});
