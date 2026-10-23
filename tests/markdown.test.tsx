import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/markdown";

/**
 * 面板里助手正文的渲染口径。
 *
 * 这里只钉**边界**：模型给的 Markdown 该变成标签而不是字面量；原始 HTML 一律不放行；
 * 外链不留在当前页。样式类名不测 —— 那是 CSS 的事。
 */
function html(md: string): string {
  return renderToStaticMarkup(<Markdown>{md}</Markdown>);
}

describe("Markdown", () => {
  it("粗体、行内代码、列表与标题都渲染成标签", () => {
    const out = html("## 进度\n\n- **甲** 已完成\n- `乙` 进行中");
    expect(out).toContain("<h2");
    expect(out).toContain("<strong");
    expect(out).toContain("<code");
    expect(out).toContain("<ul");
    expect(out).toContain("<li");
    expect(out).not.toContain("**甲**");
    expect(out).not.toContain("`乙`");
    expect(out).not.toContain("## 进度");
  });

  it("代码块保留原文，不把里面的标记当 Markdown", () => {
    const out = html("```\n**不是粗体**\n```");
    expect(out).toContain("<pre");
    expect(out).toContain("**不是粗体**");
    expect(out).not.toContain("<strong");
  });

  it("原始 HTML 只当文字，不生成元素", () => {
    // react-markdown 不引 rehype-raw：标签被转义成可见文本，既不会执行也不会变成 DOM
    const out = html("你好\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("你好");
  });

  it("外链新窗口打开并带 noopener", () => {
    const out = html("[项目](https://example.com/p)");
    expect(out).toContain('href="https://example.com/p"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
  });

  it("GFM：表格与任务清单", () => {
    const out = html("| 人 | 活 |\n| --- | --- |\n| 甲 | 写 |\n\n- [x] 已办\n- [ ] 未办");
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain("<td");
    expect(out).toContain('type="checkbox"');
  });

  it("单个换行留成 <br>，整段平铺不会粘成一行", () => {
    const out = html("第一行\n第二行");
    expect(out).toContain("<br");
    expect(out).toContain("第一行");
    expect(out).toContain("第二行");
  });

  it("远端图片不自动加载，只用链接给出", () => {
    const out = html("![截图](https://example.com/a.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("https://example.com/a.png");
    expect(out).toContain("[图片：截图]");
  });
});
