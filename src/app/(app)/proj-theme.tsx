"use client";

import { useEffect, useRef, type ReactNode } from "react";

// 星点用确定性伪随机（SSR/客户端一致，避免 hydration mismatch）
function seeded(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const STARS = Array.from({ length: 44 }, (_, i) => ({
  left: (seeded(i, 1) * 100).toFixed(2) + "vw",
  top: (seeded(i, 2) * 100).toFixed(2) + "vh",
  size: seeded(i, 3) < 0.8 ? "1px" : "2px",
  dur: (2.5 + seeded(i, 4) * 4).toFixed(2) + "s",
  delay: (-seeded(i, 5) * 6).toFixed(2) + "s",
}));

export function ProjTheme({ children }: { children: ReactNode }) {
  const cometRef = useRef<HTMLCanvasElement>(null);

  // 挂载时给 body 加任务页作用域类，卸载移除（避免污染列表页/欢迎页）
  useEffect(() => {
    document.body.classList.add("proj-cosmic");
    return () => document.body.classList.remove("proj-cosmic");
  }, []);

  // 彗星拖尾（照搬 mockup 的 rAF 粒子循环）
  useEffect(() => {
    const canvas = cometRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const fit = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    fit();
    window.addEventListener("resize", fit);

    let mx = window.innerWidth / 2;
    let my = window.innerHeight / 2;
    let pdx = mx;
    let pdy = my;
    const particles: {
      x: number; y: number; vx: number; vy: number; life: number; r: number;
    }[] = [];
    const onMove = (e: MouseEvent) => {
      mx = e.clientX;
      my = e.clientY;
    };

    const loop = () => {
      const vx = mx - pdx;
      const vy = my - pdy;
      const speed = Math.hypot(vx, vy);
      if (speed > 1) {
        const n = Math.min(6, Math.floor(speed / 5) + 1);
        for (let i = 0; i < n; i++) {
          particles.push({
            x: mx + (Math.random() - 0.5) * 4,
            y: my + (Math.random() - 0.5) * 4,
            vx: -vx * 0.05 + (Math.random() - 0.5) * 0.4,
            vy: -vy * 0.05 + (Math.random() - 0.5) * 0.4,
            life: 1,
            r: 1.4 + Math.random() * 2.4,
          });
        }
      }
      pdx = mx;
      pdy = my;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.028;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(198,222,250," + (p.life * 0.75).toFixed(3) + ")";
        ctx.shadowColor = "rgba(170,210,255,.95)";
        ctx.shadowBlur = 12 * p.life;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener("mousemove", onMove);
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <>
      <div className="proj-bg" aria-hidden />
      <div className="proj-shade" aria-hidden />
      <div className="proj-startrail" aria-hidden />
      <div className="proj-stars" aria-hidden>
        {STARS.map((s, i) => (
          <i
            key={i}
            style={{
              left: s.left,
              top: s.top,
              width: s.size,
              height: s.size,
              animationDuration: s.dur,
              animationDelay: s.delay,
            }}
          />
        ))}
      </div>
      <div className="proj-blob b1" aria-hidden />
      <div className="proj-blob b2" aria-hidden />
      <div className="proj-blob b3" aria-hidden />
      <canvas ref={cometRef} id="proj-comet" aria-hidden />
      {children}
    </>
  );
}
