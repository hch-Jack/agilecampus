import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { buildPersonalTools, buildTools } from "@/lib/agent/tools";
import { commitPersonalDraft } from "@/lib/agent/commit";
import {
  createSkill,
  deleteSkill,
  listAvailableSkills,
  listMySkills,
  resolveSkill,
  setSkillEnabled,
  updateSkill,
  SKILL_DESCRIPTION_MAX,
} from "@/lib/skill";
import {
  buildSkillCatalogBlock,
  readSkillFileForTool,
  readSkillForTool,
} from "@/lib/agent/skills";
import { resetDb } from "./helpers";

const opts = {} as never;

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

const DRAFT = {
  name: "code-review",
  description: "审查代码时按固定步骤做",
  instructions: "# 代码审查\n1. 先读 diff\n2. 只列可验证的问题",
};

describe("技能数据层", () => {
  beforeEach(resetDb);

  it("创建、列出与名称唯一（大小写不敏感），并拒绝重名内置技能", async () => {
    const user = await makeUser("skills@example.com");
    const created = await createSkill(user.id, DRAFT);
    expect(created).toMatchObject({ ...DRAFT, source: "manual", enabled: true, files: [] });

    expect((await listMySkills(user.id)).map((s) => s.name)).toEqual(["code-review"]);

    await expect(
      createSkill(user.id, { ...DRAFT, name: "CODE-Review" }),
    ).rejects.toThrow("已有同名技能");
    await expect(
      createSkill(user.id, { ...DRAFT, name: "weekly-report" }),
    ).rejects.toThrow("内置技能");
  });

  it("校验长度与必填", async () => {
    const user = await makeUser("limits@example.com");
    await expect(createSkill(user.id, { ...DRAFT, name: "  " })).rejects.toThrow(
      "技能名称不能为空",
    );
    await expect(
      createSkill(user.id, { ...DRAFT, description: "x".repeat(SKILL_DESCRIPTION_MAX + 1) }),
    ).rejects.toThrow("技能描述最多");
    await expect(createSkill(user.id, { ...DRAFT, instructions: "" })).rejects.toThrow(
      "技能正文不能为空",
    );
  });

  it("隔离：别人看不到、也改不了我的技能", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    const skill = await createSkill(a.id, DRAFT);

    expect(await listMySkills(b.id)).toEqual([]);
    expect((await listAvailableSkills(b.id)).map((s) => s.name)).not.toContain("code-review");
    await expect(resolveSkill(b.id, "code-review")).rejects.toThrow("没有叫");
    await expect(
      updateSkill(b.id, skill.id, { ...DRAFT, description: "被别人改" }),
    ).rejects.toThrow("技能不存在");
    await expect(deleteSkill(b.id, skill.id)).rejects.toThrow("技能不存在");
  });

  it("停用后不再出现在目录里，也不能被读取；重新启用恢复", async () => {
    const user = await makeUser("toggle@example.com");
    const skill = await createSkill(user.id, DRAFT);

    await setSkillEnabled(user.id, skill.id, false);
    expect((await listAvailableSkills(user.id)).map((s) => s.name)).not.toContain(
      "code-review",
    );
    await expect(resolveSkill(user.id, "code-review")).rejects.toThrow("已停用");

    await setSkillEnabled(user.id, skill.id, true);
    await expect(resolveSkill(user.id, "code-review")).resolves.toMatchObject({
      name: "code-review",
    });
  });

  it("只改名称/描述/正文时保留参考文件", async () => {
    const user = await makeUser("files@example.com");
    const created = await createSkill(user.id, {
      ...DRAFT,
      files: [{ path: "references/checklist.md", content: "- [ ] 检查" }],
    });
    const updated = await updateSkill(user.id, created.id, {
      name: created.name,
      description: "新描述",
      instructions: "新正文",
    });
    expect(updated.description).toBe("新描述");
    expect(updated.files).toEqual([
      { path: "references/checklist.md", content: "- [ ] 检查" },
    ]);

    // 显式传 files（空数组）才覆盖
    const cleared = await updateSkill(user.id, created.id, {
      name: created.name,
      description: "新描述",
      instructions: "新正文",
      files: [],
    });
    expect(cleared.files).toEqual([]);
  });
});

describe("技能目录与读取工具", () => {
  beforeEach(resetDb);

  it("目录列内置与启用的用户技能，并带上「不是最高指令」的约束", async () => {
    const user = await makeUser("catalog@example.com");
    await createSkill(user.id, DRAFT);
    const disabled = await createSkill(user.id, {
      ...DRAFT,
      name: "disabled-skill",
    });
    await setSkillEnabled(user.id, disabled.id, false);

    const block = await buildSkillCatalogBlock(user.id);
    expect(block).toContain("weekly-report");
    expect(block).toContain("code-review");
    expect(block).not.toContain("disabled-skill");
    expect(block).toContain("不是最高指令");
    expect(block).toContain("read_skill");
  });

  it("read_skill 返回正文与文件清单；read_skill_file 按路径读取", async () => {
    const user = await makeUser("read@example.com");
    await createSkill(user.id, {
      ...DRAFT,
      files: [{ path: "references/checklist.md", content: "- [ ] 检查" }],
    });

    const skill = await readSkillForTool(user.id, "code-review");
    expect(skill.instructions).toContain("先读 diff");
    expect(skill.files).toEqual([{ path: "references/checklist.md", chars: 8 }]);

    const file = await readSkillFileForTool(
      user.id,
      "code-review",
      "references/checklist.md",
    );
    expect(file).toEqual({ path: "references/checklist.md", content: "- [ ] 检查", truncated: false });

    await expect(
      readSkillFileForTool(user.id, "code-review", "references/missing.md"),
    ).rejects.toThrow("没有「references/missing.md」");
  });

  it("内置技能可读，但没有参考文件", async () => {
    const user = await makeUser("builtin@example.com");
    const skill = await readSkillForTool(user.id, "weekly-report");
    expect(skill.source).toBe("builtin");
    expect(skill.instructions).toContain("项目周报");
    expect(skill.files).toEqual([]);
    await expect(
      readSkillFileForTool(user.id, "weekly-report", "x.md"),
    ).rejects.toThrow("内置技能");
  });
});

describe("助手侧：read_skill / create_skill", () => {
  beforeEach(resetDb);

  async function scene() {
    const owner = await makeUser("owner@example.com");
    const team = await createTeam(owner.id, "东吴实验室");
    const student = await makeUser("student@example.com");
    await joinTeam(student.id, team.inviteCode);
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    return { owner, team, student, project };
  }

  it("技能工具只在个人助手，不进项目助手", async () => {
    const { owner, project } = await scene();
    expect(buildPersonalTools(owner.id)).toHaveProperty("read_skill");
    expect(buildPersonalTools(owner.id)).toHaveProperty("read_skill_file");
    expect(buildPersonalTools(owner.id)).toHaveProperty("create_skill");

    const projectTools = buildTools(owner.id, project.id);
    expect("read_skill" in projectTools).toBe(false);
    expect("create_skill" in projectTools).toBe(false);
  });

  it("read_skill 走得通；未知技能把可用名称列出来", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);
    const out = (await tools.read_skill.execute!({ name: "weekly-report" }, opts)) as {
      instructions: string;
    };
    expect(out.instructions).toContain("项目周报");

    await expect(
      tools.read_skill.execute!({ name: "不存在的技能" }, opts),
    ).rejects.toThrow("可用技能：weekly-report");
  });

  it("create_skill 只拟草案；确认后落库，来源记为助手", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = (await tools.create_skill.execute!(DRAFT, opts)) as {
      __draft: true;
      tool: string;
      draft: typeof DRAFT;
    };
    expect(env).toMatchObject({ __draft: true, tool: "create_skill" });
    expect(await listMySkills(student.id)).toEqual([]);

    await commitPersonalDraft(student.id, "create_skill", env.draft);
    const [saved] = await listMySkills(student.id);
    expect(saved).toMatchObject({ ...DRAFT, source: "agent", enabled: true });
  });

  it("拟稿时就挡住重名：不用等用户点确认", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);
    await createSkill(student.id, DRAFT);
    await expect(tools.create_skill.execute!(DRAFT, opts)).rejects.toThrow("已有同名技能");
  });
});
