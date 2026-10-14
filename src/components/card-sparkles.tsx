"use client";

import { useEffect, useRef, useState } from "react";

// 悬停卡片时，从四边不断生出白色星光粒子，缓慢向外飘散后消失，循环不止。
export function CardSparkles() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const rafRef = useRef<number>(0);
  const lastSpawnRef = useRef(0);

  // 监听宿主卡片（父元素）的悬停状态
  useEffect(() => {
    const host = hostRef.current?.parentElement;
    if (!host) return;
    const onEnter = () => {
      setActive(true);
      // 悬停瞬间：卡片左右抖动一次（放大与抖动合并进同一段动画）
      host.animate(
        [
          { transform: "translateY(-3px) translateX(0px)" },
          { transform: "translateY(-3px) translateX(-8px)", offset: 0.14 },
          { transform: "translateY(-3px) translateX(7px)", offset: 0.3 },
          { transform: "translateY(-3px) translateX(-5px)", offset: 0.46 },
          { transform: "translateY(-3px) translateX(4px)", offset: 0.62 },
          { transform: "translateY(-3px) translateX(-2px)", offset: 0.78 },
          { transform: "translateY(-3px) translateX(0px)", offset: 1 },
        ],
        { duration: 600, easing: "ease" },
      );
    };
    const onLeave = () => setActive(false);
    host.addEventListener("mouseenter", onEnter);
    host.addEventListener("mouseleave", onLeave);
    return () => {
      host.removeEventListener("mouseenter", onEnter);
      host.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  // 悬停期间持续生成粒子
  useEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    if (!host) return;

    const spawn = () => {
      const el = document.createElement("span");
      el.style.position = "absolute";
      el.style.borderRadius = "50%";
      el.style.background = "#fff";
      el.style.boxShadow =
        "0 0 3px 1px rgba(255,255,255,1), 0 0 9px 3px rgba(200,225,255,.95), 0 0 16px 6px rgba(150,195,245,.6)";
      el.style.pointerEvents = "none";

      const size = 2 + Math.random() * 3;
      el.style.width = `${size.toFixed(1)}px`;
      el.style.height = `${size.toFixed(1)}px`;

      const w = host.clientWidth;
      const h = host.clientHeight;
      const edge = Math.floor(Math.random() * 4); // 0 上 1 右 2 下 3 左
      const t = Math.random(); // 沿该边的随机位置
      let x: number, y: number, dx: number, dy: number;

      if (edge === 0) {
        x = t * w; y = 0;
        dx = (Math.random() - 0.5) * 26;
        dy = -(10 + Math.random() * 34);
      } else if (edge === 1) {
        x = w; y = t * h;
        dx = 10 + Math.random() * 34;
        dy = (Math.random() - 0.5) * 26;
      } else if (edge === 2) {
        x = t * w; y = h;
        dx = (Math.random() - 0.5) * 26;
        dy = 10 + Math.random() * 34;
      } else {
        x = 0; y = t * h;
        dx = -(10 + Math.random() * 34);
        dy = (Math.random() - 0.5) * 26;
      }

      el.style.left = `${x.toFixed(1)}px`;
      el.style.top = `${y.toFixed(1)}px`;
      host.appendChild(el);

      const duration = 1600 + Math.random() * 1600; // 慢速飘散
      const anim = el.animate(
        [
          { transform: "translate(0px, 0px) scale(1)", opacity: 0 },
          { opacity: 1, offset: 0.15 },
          {
            transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(0.3 + Math.random() * 0.4).toFixed(2)})`,
            opacity: 0,
          },
        ],
        { duration, easing: "ease-out" },
      );
      anim.onfinish = () => el.remove();
    };

    const tick = (now: number) => {
      if (now - lastSpawnRef.current > 90) {
        lastSpawnRef.current = now;
        spawn();
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    lastSpawnRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      host.querySelectorAll("span").forEach((n) => n.remove());
    };
  }, [active]);

  return <div ref={hostRef} className="pointer-events-none absolute inset-0 z-10" aria-hidden />;
}
