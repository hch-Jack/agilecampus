import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CATEGORY_MAX,
  CONVERSATION_CATEGORY_PRESETS,
  categoryLabel,
  classifyConversationText,
  compareConversationCategories,
  normalizeConversationCategory,
} from "@/lib/agent/conversation-category";

describe("会话分类：关键词自动归类", () => {
  it("任务/项目类问法归到项目与任务", () => {
    expect(classifyConversationText("帮我看下赤壁演习这个项目的进度")).toBe("项目与任务");
    expect(classifyConversationText("把这条需求拆解成子任务")).toBe("项目与任务");
  });

  it("消息、文件、日程、团队、学习各有归属", () => {
    expect(classifyConversationText("给张三发一条私信，把文件转发过去")).toBe("消息与沟通");
    expect(classifyConversationText("把这份报告导出成 xlsx 表格")).toBe("文件与文档");
    expect(classifyConversationText("下周三截止的会议安排记一下")).toBe("日程与计划");
    expect(classifyConversationText("邀请组员进团队，管理员需要审批")).toBe("团队与协作");
    expect(classifyConversationText("解释一下这个概念，考试会考")).toBe("学习与问答");
  });

  it("多个关键词时按命中数取胜，平票按预设顺序", () => {
    // 项目+任务+进度 3 分 > 学习类 1 分
    expect(classifyConversationText("项目任务进度怎么更新")).toBe("项目与任务");
    // 文件类命中 3 个（文件/附件/上传）> 学习类 1 个（为什么）
    expect(classifyConversationText("文件附件为什么上传失败")).toBe("文件与文档");
  });

  it("没命中、空串都返回 null（不瞎猜「其他」）", () => {
    expect(classifyConversationText("你好呀")).toBeNull();
    expect(classifyConversationText("   ")).toBeNull();
    expect(classifyConversationText("")).toBeNull();
  });

  it("英文关键词按小写匹配", () => {
    expect(classifyConversationText("show me the TASK progress")).toBe("项目与任务");
  });
});

describe("会话分类：命名与排序", () => {
  it("规范化：去空白/控制字符，按码点截断，空值 → null", () => {
    expect(normalizeConversationCategory("  项目与任务  ")).toBe("项目与任务");
    // 控制字符（含换行）转空格而不是删掉，避免两截粘成一个词
    expect(normalizeConversationCategory("a\u0000b\nc")).toBe("a b c");
    expect(normalizeConversationCategory("   ")).toBeNull();
    expect(normalizeConversationCategory(null)).toBeNull();
    expect(normalizeConversationCategory(42)).toBeNull();
    const long = "长".repeat(CONVERSATION_CATEGORY_MAX + 5);
    expect(Array.from(normalizeConversationCategory(long)!)).toHaveLength(
      CONVERSATION_CATEGORY_MAX,
    );
  });

  it("分组排序：预设顺序 → 自定义 → 未分类垫底", () => {
    const list = ["自定义乙", null, "学习与问答", "自定义甲", "项目与任务"];
    expect([...list].sort(compareConversationCategories)).toEqual([
      "项目与任务",
      "学习与问答",
      "自定义甲", // zh-Hans-CN 排序走拼音：jiǎ < yǐ
      "自定义乙",
      null,
    ]);
    // 预设全集自洽：排序后顺序不变（去掉「其他」以外都应在前面）
    const presets = [...CONVERSATION_CATEGORY_PRESETS];
    expect([...presets].sort(compareConversationCategories)).toEqual(presets);
  });

  it("未分类的展示名", () => {
    expect(categoryLabel(null)).toBe("未分类");
    expect(categoryLabel("项目与任务")).toBe("项目与任务");
  });
});
