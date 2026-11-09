import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  parseSkillUpload,
  splitFrontmatter,
} from "@/lib/agent/skill-import";
import { normalizeSkillPath, SKILL_INSTRUCTIONS_MAX } from "@/lib/skill";

const encoder = new TextEncoder();

function md(text: string): Uint8Array {
  return encoder.encode(text);
}

describe("splitFrontmatter", () => {
  it("解析 name / description，正文从结束线之后开始", () => {
    const { meta, body } = splitFrontmatter(
      "---\nname: weekly-report\ndescription: 生成周报\n---\n# 周报\n正文",
    );
    expect(meta).toEqual({ name: "weekly-report", description: "生成周报" });
    expect(body).toBe("# 周报\n正文");
  });

  it("支持 > 与 | 块标量，以及引号", () => {
    const { meta } = splitFrontmatter(
      [
        "---",
        'name: "review"',
        "description: >-",
        "  第一行",
        "  第二行",
        "license: |",
        "  MIT",
        "---",
        "body",
      ].join("\n"),
    );
    expect(meta.name).toBe("review");
    expect(meta.description).toBe("第一行 第二行");
    expect(meta.license).toBe("MIT");
  });

  it("没有 frontmatter 或没闭合时原样返回", () => {
    expect(splitFrontmatter("# 标题\n正文")).toEqual({
      meta: {},
      body: "# 标题\n正文",
    });
    expect(splitFrontmatter("---\nname: x\n正文")).toEqual({
      meta: {},
      body: "---\nname: x\n正文",
    });
  });
});

describe("parseSkillUpload：Markdown", () => {
  it("Claude SKILL.md（带 frontmatter）", async () => {
    const parsed = await parseSkillUpload(
      "weekly-report.md",
      md("---\nname: weekly-report\ndescription: 汇总项目本周进度\n---\n# 周报\n按步骤生成。"),
    );
    expect(parsed).toMatchObject({
      name: "weekly-report",
      description: "汇总项目本周进度",
      instructions: "# 周报\n按步骤生成。",
      files: [],
      origin: "claude",
    });
  });

  it("普通 Markdown：首个 H1 当名称、首段当描述", async () => {
    const parsed = await parseSkillUpload(
      "code-review.md",
      md("# 代码审查\n先读改动，再列出问题。\n\n## 步骤\n1. 读 diff"),
    );
    expect(parsed.name).toBe("代码审查");
    expect(parsed.description).toBe("先读改动，再列出问题。");
    expect(parsed.instructions).toContain("## 步骤");
    expect(parsed.origin).toBe("markdown");
  });

  it("没有标题时用文件名兜底", async () => {
    const parsed = await parseSkillUpload("checklist.md", md("逐项检查。\n- 甲\n- 乙"));
    expect(parsed.name).toBe("checklist");
    expect(parsed.description).toBe("逐项检查。");
  });

  it("正文为空 / 超长 / 空文件都拒绝", async () => {
    await expect(parseSkillUpload("empty.md", md(""))).rejects.toThrow("文件是空的");
    await expect(parseSkillUpload("blank.md", md("---\nname: x\n---\n"))).rejects.toThrow(
      "技能正文为空",
    );
    await expect(
      parseSkillUpload("long.md", md("x".repeat(SKILL_INSTRUCTIONS_MAX + 1))),
    ).rejects.toThrow(`技能正文最多 ${SKILL_INSTRUCTIONS_MAX} 字`);
  });
});

describe("parseSkillUpload：JSON", () => {
  it("OpenAI / DeepSeek 风格：name + description + instructions", async () => {
    const parsed = await parseSkillUpload(
      "gpt.json",
      md(JSON.stringify({ name: "总结", description: "把长文压成要点", instructions: "先分段再总结" })),
    );
    expect(parsed).toMatchObject({
      name: "总结",
      description: "把长文压成要点",
      instructions: "先分段再总结",
      origin: "json",
    });
  });

  it("兼容 prompt / body 等别名，并接受 files", async () => {
    const parsed = await parseSkillUpload(
      "deepseek.json",
      md(
        JSON.stringify({
          name: "写作",
          prompt: "按提纲写",
          files: [{ path: "templates/outline.md", content: "# 提纲" }],
        }),
      ),
    );
    expect(parsed.instructions).toBe("按提纲写");
    expect(parsed.description).toBe("按提纲写");
    expect(parsed.files).toEqual([{ path: "templates/outline.md", content: "# 提纲" }]);
  });

  it("非法 JSON / 缺正文拒绝", async () => {
    await expect(parseSkillUpload("bad.json", md("{oops"))).rejects.toThrow("JSON 格式无效");
    await expect(parseSkillUpload("no-body.json", md('{"name":"x"}'))).rejects.toThrow(
      "没有找到技能正文",
    );
  });
});

describe("parseSkillUpload：zip 技能包", () => {
  async function makeZip(entries: Record<string, string | Uint8Array>) {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(entries)) zip.file(path, content);
    return zip.generateAsync({ type: "uint8array" });
  }

  it("读取 SKILL.md，收集同目录的文本参考文件，跳过二进制", async () => {
    const data = await makeZip({
      "my-skill/SKILL.md":
        "---\nname: my-skill\ndescription: 我的技能\n---\n# 正文\n步骤一。",
      "my-skill/references/checklist.md": "- [ ] 检查",
      "my-skill/scripts/run.sh": "echo hi",
      "my-skill/assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      "unrelated/other.md": "不在技能目录里",
    });
    const parsed = await parseSkillUpload("bundle.zip", data);
    expect(parsed).toMatchObject({
      name: "my-skill",
      description: "我的技能",
      origin: "claude",
    });
    expect(parsed.files.map((f) => f.path)).toEqual([
      "references/checklist.md",
      "scripts/run.sh",
    ]);
  });

  it("SKILL.md 在根目录时收集整包", async () => {
    const data = await makeZip({
      "SKILL.md": "# 根技能\n正文。",
      "notes.md": "备注",
    });
    const parsed = await parseSkillUpload("root.zip", data);
    expect(parsed.name).toBe("根技能");
    expect(parsed.files.map((f) => f.path)).toEqual(["notes.md"]);
  });

  it("没有 SKILL.md / 损坏的 zip 都拒绝", async () => {
    const noSkill = await makeZip({ "readme.md": "hi" });
    await expect(parseSkillUpload("no-skill.zip", noSkill)).rejects.toThrow(
      "没有找到 SKILL.md",
    );
    await expect(parseSkillUpload("broken.zip", md("not a zip"))).rejects.toThrow(
      "无法读取 zip 包",
    );
  });

  it("参考文件路径不允许穿越（JSZip 会先做一层，这里是第二道）", () => {
    expect(() => normalizeSkillPath("../evil.md")).toThrow("路径不合法");
    expect(() => normalizeSkillPath("references/../../etc/passwd")).toThrow(
      "路径不合法",
    );
    expect(normalizeSkillPath("references/checklist.md")).toBe("references/checklist.md");
  });
});
