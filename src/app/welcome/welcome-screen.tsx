"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clockParts } from "@/lib/time";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

// 名言池 · 古今中外 · 贴合「学习 / 安静 / 思考」
const QUOTES = [
  { t: "学而不思则罔，思而不学则殆", a: "孔子" },
  { t: "博学之，审问之，慎思之，明辨之，笃行之", a: "《中庸》" },
  { t: "业精于勤，荒于嬉；行成于思，毁于随", a: "韩愈" },
  { t: "读书破万卷，下笔如有神", a: "杜甫" },
  { t: "问渠那得清如许？为有源头活水来", a: "朱熹" },
  { t: "静故了群动，空故纳万境", a: "苏轼" },
  { t: "非宁静无以致远", a: "诸葛亮" },
  { t: "独立之精神，自由之思想", a: "陈寅恪" },
  { t: "怕什么真理无穷，进一寸有一寸的欢喜", a: "胡适" },
  { t: "哪里有天才，我是把别人喝咖啡的工夫都用在工作上了", a: "鲁迅" },
  { t: "我思故我在", a: "笛卡尔" },
  { t: "人是一根会思考的芦苇", a: "帕斯卡" },
  { t: "我唯一知道的，就是我一无所知", a: "苏格拉底" },
  { t: "如果我看得更远，是因为我站在巨人的肩膀上", a: "牛顿" },
];

type Props = {
  username: string;
  /** 用户头像 URL，null 表示没传过头像（回落成名字首字） */
  avatarUrl: string | null;
  /** 用户所选时区：钟面、日期、昼夜与问候语一律按它算，不按浏览器本地时间 */
  timeZone: string;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
  doing: number;
  /** 今日计划：日程表里覆盖今天的排期任务数 */
  plannedToday: number;
};

export function WelcomeScreen({
  username,
  avatarUrl,
  timeZone,
  overdue,
  dueToday,
  dueThisWeek,
  doing,
  plannedToday,
}: Props) {
  const [now, setNow] = useState<Date | null>(null);
  const [quote] = useState(() => QUOTES[Math.floor(Math.random() * QUOTES.length)]);
  const [day, setDay] = useState(false);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(d);
      const force = /[?&]day/.test(window.location.search)
        ? true
        : /[?&]night/.test(window.location.search)
          ? false
          : null;
      // 昼夜配色与问候语跟着用户选的时区走：选了北京时间而人身在国外时，
      // 「早上好」该按北京时间的早上说
      const h = clockParts(timeZone, d).hour;
      setDay(force !== null ? force : h >= 5 && h < 18);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timeZone]);

  const clock = now ? clockParts(timeZone, now) : null;
  const h = clock?.hour;
  const hh = clock?.hh ?? "--";
  const mm = clock?.mm ?? "--";
  const ss = clock?.ss ?? "--";
  const dateStr = clock ? `${clock.dateLabel} · 星期${WEEK[clock.weekday]}` : "— —";

  let greet = "…";
  if (h !== undefined) {
    if (h < 5) greet = "夜深了";
    else if (h < 9) greet = "早上好";
    else if (h < 12) greet = "上午好";
    else if (h < 14) greet = "中午好";
    else if (h < 18) greet = "下午好";
    else greet = "晚上好";
  }

  const cls = `welcome${day ? " day" : ""} reveal`;

  return (
    <>
      <div className={cls}>
        <div className="bg" />
        <div className="blob b1" />
        <div className="blob b2" />
        <div className="blob b3" />

      <div className="brand">
        <div className="dot" />
        <div className="name">
          <b>AgileCampus</b> · 敏捷校园
        </div>
      </div>

      <main className="center">
        <div className="date">{dateStr}</div>
        <div className="clock">
          <span className="t t1">{hh}</span><span className="sep">:</span><span className="t t2">{mm}</span><span className="sep">:</span><span className="t t3">{ss}</span>
        </div>
        <div className="greet">
          {greet}，{username}
        </div>
        <div className="quote">{quote.t}</div>
        <div className="quote-by">—— {quote.a}</div>

        <div className="chips">
          <div className="chip-row">
            <div className="chip c1">
              <span className="c-dot overdue" />
              <b>{overdue}</b> 项任务已逾期
            </div>
            <div className="chip c2">
              <span className="c-dot today" />
              <b>{dueToday}</b> 项任务今日截止
            </div>
            <div className="chip c3">
              <span className="c-dot week" />
              <b>{dueThisWeek}</b> 项任务本周截止
            </div>
          </div>
          <div className="chip-row">
            <div className="chip c4">
              <span className="c-dot doing" />
              <b>{doing}</b> 项任务正在进行中
            </div>
            <div className="chip c5">
              <span className="c-dot plan" />
              今日计划 <b>{plannedToday}</b> 项任务
            </div>
          </div>
        </div>

          <Link className="enter" href="/dashboard">
            进入工作台 →
          </Link>
        </main>
      </div>
    </>
  );
}
