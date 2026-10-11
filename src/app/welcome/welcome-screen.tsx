"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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
  doing: number;
  todo: number;
  risk: number;
};

export function WelcomeScreen({
  username,
  doing,
  todo,
  risk,
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
      setDay(force !== null ? force : d.getHours() >= 5 && d.getHours() < 18);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const h = now?.getHours();
  const hh = now ? String(now.getHours()).padStart(2, "0") : "--";
  const mm = now ? String(now.getMinutes()).padStart(2, "0") : "--";
  const ss = now ? String(now.getSeconds()).padStart(2, "0") : "--";
  const dateStr = now
    ? `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${WEEK[now.getDay()]}`
    : "— —";

  let greet = "…";
  if (h !== undefined) {
    if (h < 5) greet = "夜深了";
    else if (h < 9) greet = "早上好";
    else if (h < 12) greet = "上午好";
    else if (h < 14) greet = "中午好";
    else if (h < 18) greet = "下午好";
    else greet = "晚上好";
  }

  return (
    <div className={day ? "welcome day" : "welcome"}>
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
          <div className="chip c1">
            <span className="c-dot doing" />
            正在进行中的任务 <b>{doing}</b> 项
          </div>
          <div className="chip c2">
            <span className="c-dot todo" />
            还有 <b>{todo}</b> 项任务等待开始
          </div>
          <div className="chip c3">
            <span className="c-dot risk" />
            有 <b>{risk}</b> 项任务临近逾期
          </div>
        </div>

        <Link className="enter" href="/projects">
          进入工作台 →
        </Link>
      </main>
    </div>
  );
}
