import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { loadBurndown, type BurndownPace } from "@/lib/burndown";
import { BurndownChart, type PaceNote } from "./burndown-chart";

const fmtDay = (day: string) => day.replace(/-/g, "/");
const dayNum = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** 吞吐预测 → 一行结论（warn=预计逾期 / ok=可按期 / flat=无法外推） */
function paceNote(pace: BurndownPace, deadlineDay: string | null): PaceNote {
  if (!pace) return null;
  const rate = `${Math.round(pace.ratePerDay * 10) / 10} 个/天`;
  if (!pace.forecastDay) return { tone: "flat", text: `近 14 天无净完成任务，暂无法按节奏预测完成日。` };
  if (deadlineDay) {
    const late = dayNum(pace.forecastDay) - dayNum(deadlineDay);
    if (late > 0)
      return {
        tone: "warn",
        text: `按近 14 天节奏（${rate}）预计 ${fmtDay(pace.forecastDay)} 完成，将晚于截止日 ${late} 天。`,
      };
    return {
      tone: "ok",
      text: `按近 14 天节奏（${rate}）预计 ${fmtDay(pace.forecastDay)} 完成，不晚于截止日。`,
    };
  }
  return { tone: "flat", text: `按近 14 天节奏（${rate}）预计 ${fmtDay(pace.forecastDay)} 完成（项目未设截止日）。` };
}

/**
 * 项目燃尽图：剩余任务/总规模随天的阶梯线（顶层任务口径，与看板同）。
 * 数据由任务动态重放，终点锚定当前看板状态；有截止日时叠加理想参考线。
 */
export default async function BurndownPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(projectId).success) notFound();

  const data = await loadBurndown(session.user.id, projectId);
  if (!data) notFound();

  return (
    <main className="mx-auto max-w-4xl space-y-5 py-5 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold text-ink">燃尽图</h1>
          <p className="mt-0.5 truncate text-sm text-ink-faint">{data.projectName}</p>
        </div>
        <Link href={`/projects/${projectId}`} className="ac-btn-ghost whitespace-nowrap">
          ← 返回项目
        </Link>
      </div>

      {!data.hasTasks ? (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          项目还没有顶层任务——创建任务并推进后，这里会出现燃尽曲线。
        </div>
      ) : (
        <BurndownChart
          points={data.points}
          ideal={data.ideal}
          todayDay={data.todayDay}
          paceNote={paceNote(data.pace, data.deadlineDay)}
        />
      )}

      <p className="text-xs leading-relaxed text-ink-faint">
        口径：顶层任务（与看板列一致，子任务不重复计数）。「剩余」看板未完成任务数，「总规模」随任务创建/删除增减；
        {data.deadlineDay
          ? `截止日 ${fmtDay(data.deadlineDay)}。理想（虚线）按剩余任务各自的截止日阶梯归零：截止日早的先下台阶，`
          : "项目未设截止日。"}{" "}
        未填截止日的任务在线上线性均摊；节奏标注按近 14 天实际完成速率外推。
        曲线由任务动态重放得出，终点与当前看板状态对齐。
      </p>
    </main>
  );
}
