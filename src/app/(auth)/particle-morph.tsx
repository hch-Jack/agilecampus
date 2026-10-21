"use client";

import { useEffect, useRef } from "react";

/**
 * 3D 粒子 morph 背景 —— 漆黑深空里，发光粒子不断重组成
 * 球体、立方体、环面、螺旋、波浪面等立体图形，粒子间以
 * 发光线网相连（星座/网络感），配色走科技青蓝紫霓虹。
 * 纯 Canvas 2D（零依赖）：自转 + 透视投影 + 连线 + 辉光叠加。
 */
export function ParticleMorph() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const N = 800; // 粒子总数（连线效果下点更清晰）

    // —— 形状采样函数（返回约 [-1,1] 的单位空间点，只算一次缓存下来）——
    const GOLD = Math.PI * (3 - Math.sqrt(5)); // 黄金角，用于均匀铺点
    const shapes: Array<(i: number) => [number, number, number]> = [
      // 球体：fibonacci 球面均匀分布
      (i) => {
        const y = 1 - (2 * (i + 0.5)) / N;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const t = GOLD * i;
        return [Math.cos(t) * r, y, Math.sin(t) * r];
      },
      // 立方体：六面网格
      (i) => {
        const perFace = Math.floor(N / 6);
        const face = Math.min(5, Math.floor(i / perFace));
        const idx = i % perFace;
        const side = Math.round(Math.sqrt(perFace));
        const row = Math.floor(idx / side);
        const col = idx % side;
        const u = (col / Math.max(1, side - 1)) * 2 - 1;
        const v = (row / Math.max(1, side - 1)) * 2 - 1;
        switch (face) {
          case 0: return [u, v, 1];
          case 1: return [u, v, -1];
          case 2: return [u, 1, v];
          case 3: return [u, -1, v];
          case 4: return [1, u, v];
          default: return [-1, u, v];
        }
      },
      // 环面（甜甜圈）
      (i) => {
        const R = 0.7, r = 0.3;
        const u = (i / N) * Math.PI * 2;
        const v = (GOLD * i) % (Math.PI * 2);
        return [
          (R + r * Math.cos(v)) * Math.cos(u),
          r * Math.sin(v),
          (R + r * Math.cos(v)) * Math.sin(u),
        ];
      },
      // 螺旋（弹簧）
      (i) => {
        const turns = 4;
        const t = (i / N) * turns * Math.PI * 2;
        const r = 0.62;
        const y = (i / N) * 2 - 1;
        return [Math.cos(t) * r, y, Math.sin(t) * r];
      },
      // DNA 双螺旋
      (i) => {
        const t = (i / N) * Math.PI * 4;
        const strand = i % 2;
        const ang = t + strand * Math.PI;
        return [Math.cos(ang) * 0.4, (i / N) * 2 - 1, Math.sin(ang) * 0.4];
      },
      // 三叶结（trefoil knot）：立体绳结曲线，旋转起来极具科技感
      (i) => {
        const t = (i / N) * Math.PI * 2;
        const a = 2 + Math.cos(3 * t);
        return [
          (a * Math.cos(2 * t)) / 3,
          Math.sin(3 * t) / 1.5,
          (a * Math.sin(2 * t)) / 3,
        ];
      },
      // 波浪面：平面网格 + 正弦起伏
      (i) => {
        const grid = Math.ceil(Math.sqrt(N));
        const col = i % grid;
        const row = Math.floor(i / grid);
        const x = (col / Math.max(1, grid - 1)) * 2 - 1;
        const y = (row / Math.max(1, grid - 1)) * 2 - 1;
        const z = Math.sin(x * 3) * Math.cos(y * 3) * 0.28;
        return [x * 0.9, z, y * 0.9];
      },
    ];

    // 预计算每个形状的 N 个 3D 点
    const shapePts = shapes.map((fn) => {
      const arr = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const p = fn(i);
        arr[i * 3] = p[0];
        arr[i * 3 + 1] = p[1];
        arr[i * 3 + 2] = p[2];
      }
      return arr;
    });

    // —— 颜色工具 ——
    const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
      h = ((h % 360) + 360) % 360;
      s /= 100; l /= 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = l - c / 2;
      let r = 0, g = 0, b = 0;
      if (h < 60) [r, g, b] = [c, x, 0];
      else if (h < 120) [r, g, b] = [x, c, 0];
      else if (h < 180) [r, g, b] = [0, c, x];
      else if (h < 240) [r, g, b] = [0, x, c];
      else if (h < 300) [r, g, b] = [x, 0, c];
      else [r, g, b] = [c, 0, x];
      return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    };

    // —— 发光精灵：亮白星核 + 彩色光晕 ——
    // blur: 0=近(锐利) 1=中 2=远(柔光斑)，用不同光晕扩散模拟景深虚化
    const makeSprite = (r: number, g: number, b: number, blur: number) => {
      const s = 96;
      const c = document.createElement("canvas");
      c.width = s; c.height = s;
      const g2 = c.getContext("2d")!;
      const grad = g2.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      if (blur === 0) {
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.28, "rgba(255,255,255,0.9)");
        grad.addColorStop(0.55, `rgba(${r},${g},${b},0.7)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      } else if (blur === 1) {
        grad.addColorStop(0, "rgba(255,255,255,0.95)");
        grad.addColorStop(0.2, "rgba(255,255,255,0.75)");
        grad.addColorStop(0.5, `rgba(${r},${g},${b},0.5)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      } else {
        grad.addColorStop(0, "rgba(255,255,255,0.7)");
        grad.addColorStop(0.25, `rgba(${r},${g},${b},0.5)`);
        grad.addColorStop(0.6, `rgba(${r},${g},${b},0.2)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      }
      g2.fillStyle = grad;
      g2.fillRect(0, 0, s, s);
      return c;
    };

    // 科技感配色：只在青(180°)→蓝→紫(280°)区间内取色，霓虹感
    const HUE_MIN = 180;
    const HUE_MAX = 280;
    const HUE_COUNT = 20;
    // 每个颜色预渲染 3 档景深模糊（近锐 / 中 / 远虚）
    const sprites = Array.from({ length: HUE_COUNT * 3 }, (_, k) => {
      const hueIdx = Math.floor(k / 3);
      const blur = k % 3;
      const h = HUE_MIN + (hueIdx / (HUE_COUNT - 1)) * (HUE_MAX - HUE_MIN);
      const [r, g, b] = hslToRgb(h, 90, 62);
      return makeSprite(r, g, b, blur);
    });

    let vw = 0, vh = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      vw = window.innerWidth;
      vh = window.innerHeight;
      canvas.width = Math.floor(vw * dpr);
      canvas.height = Math.floor(vh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // 鼠标视差：平滑跟随鼠标，营造深度与高级互动感
    let tmx = 0, tmy = 0;   // 目标（-1 ~ 1）
    let pmx = 0, pmy = 0;   // 当前平滑值
    const onMouse = (e: MouseEvent) => {
      tmx = (e.clientX / window.innerWidth - 0.5) * 2;
      tmy = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("mousemove", onMouse);

    // —— 星空背景：稀疏冷白星点，确定性伪随机生成，带呼吸闪烁 ——
    // 数量克制、颜色偏冷、透明度低，只做氛围衬托，不抢中间粒子主体
    const mulberry32 = (a: number) => {
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const STAR_COUNT = 160;
    const stars = Array.from({ length: STAR_COUNT }, (_, i) => {
      const rnd = mulberry32(i * 977 + 13);
      const size = 0.4 + rnd() * rnd() * 1.8;   // 多数小星、少数稍大
      const base = 0.1 + rnd() * 0.3;           // 基础亮度很低
      const phase = rnd() * Math.PI * 2;
      const speed = 0.0004 + rnd() * 0.001;     // 闪烁频率不一
      const tw = 0.3 + rnd() * 0.45;            // 闪烁幅度
      const tint = rnd();
      const col =
        tint < 0.72 ? [206, 222, 250] : tint < 0.93 ? [182, 206, 245] : [205, 196, 250];
      const flare = size > 1.5 && rnd() < 0.4 ? 1 : 0; // 少数亮星带淡十字星芒
      const vx = (rnd() - 0.5) * 0.00008; // 缓慢漂移，星星不死定在屏上
      const vy = (rnd() - 0.5) * 0.00005;
      return { x: rnd(), y: rnd(), size, base, phase, speed, tw, col, flare, vx, vy };
    });

    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    let fromIdx = 0;
    let toIdx = 1;
    let segStart = 0; // 基于动画累计时间 t（避免挂后台后时间戳大跳）
    const SEG = 15000; // 每个形状的周期（停留 + 重组），约 15 秒一个
    const TRANS = 0.24; // 切换只占周期 24%，其余时间都用于展示
    const FOV = 3.2; // 透视强度
    let flip = { rx: 0, ry: 0, rz: 0 }; // 切换时的翻转脉冲（弧度）

    ctx.globalCompositeOperation = "lighter"; // 发光叠加

    // 投影坐标缓存
    const sxArr = new Float32Array(N);
    const syArr = new Float32Array(N);
    const depthArr = new Float32Array(N);

    let raf = 0;
    let lastNow = 0; // 上一帧时间戳，用于流星速度
    let t = 0; // 动画累计时间：dt 封顶后累加，后台恢复时不回放
    // 流星：偶发划过，短暂点缀，不抢中间粒子主体
    const meteors: Array<{ x: number; y: number; vx: number; vy: number; life: number; maxLife: number }> = [];
    let nextMeteor = 2500;
    const frame = (now: number) => {
      // dt 封顶：切后台/标签页时 rAF 会暂停，恢复瞬间 now 大跳，
      // 封顶到 50ms 让动画平稳续走，而不是把错过的帧一下回放完
      const dt = lastNow ? Math.min(now - lastNow, 50) : 16;
      lastNow = now;
      t += dt;
      let p = (t - segStart) / SEG;
      if (p >= 1) {
        segStart += SEG;
        fromIdx = toIdx;
        toIdx = (toIdx + 1) % shapePts.length;
        p = (t - segStart) / SEG;
        // 随机选一种翻转方式：切换时图形整体翻转过去（上下/左右/斜切/斜对角）
        const dir = Math.random() < 0.5 ? 1 : -1;
        const kinds = [
          { rx: 2, ry: 0, rz: 0 }, // 上下翻
          { rx: 0, ry: 2, rz: 0 }, // 左右翻
          { rx: 0, ry: 0, rz: 2 }, // 绕视线斜翻
          { rx: 1, ry: 1, rz: 0 }, // 斜对角翻
          { rx: 0, ry: 1, rz: 1 }, // 斜对角翻
        ];
        const k = kinds[Math.floor(Math.random() * kinds.length)];
        flip = { rx: k.rx * Math.PI * dir, ry: k.ry * Math.PI * dir, rz: k.rz * Math.PI * dir };
      }
      // 展示期图形稳定自转展示各面；末尾快速 morph 切到下一个形状
      const e = p < 1 - TRANS
        ? 0
        : easeInOutCubic(Math.min(1, (p - (1 - TRANS)) / TRANS));

      // 整体自转 + 切换翻转脉冲（翻转与 morph 同步缓动）
      // 展示期绕 Y 轴转一圈多、绕 X 轴上下俯仰，让立体各面都能看到
      const ay = t * 0.0006 + flip.ry * e;
      const ax = Math.sin(t * 0.0003) * 1.0 + flip.rx * e;
      const az = flip.rz * e + Math.sin(t * 0.0002) * 0.35;
      const cosY = Math.cos(ay), sinY = Math.sin(ay);
      const cosX = Math.cos(ax), sinX = Math.sin(ax);
      const cosZ = Math.cos(az), sinZ = Math.sin(az);

      const from = shapePts[fromIdx];
      const to = shapePts[toIdx];

      const cx = vw / 2, cy = vh / 2;
      // 鼠标视差平滑（阻尼跟随）
      pmx += (tmx - pmx) * 0.04;
      pmy += (tmy - pmy) * 0.04;
      const pcx = cx + pmx * 14;   // 粒子视差中心（幅度小）
      const pcy = cy + pmy * 10;
      const scale = Math.min(vw, vh) * 0.5; // 镜头拉远，看清完整立体图形
      const sizeScale = Math.max(1.1, Math.min(vw, vh) / 650);

      // 摄像机沿 Z 轴前后穿梭（幅度加大，强化立体环绕感）
      const zCam = Math.sin(t * 0.00016) * 0.85;

      // 全体粒子统一同色，在青蓝紫区间平滑往返变色
      const hue = 220 + Math.sin(t * 0.0003) * 60;
      const hueT = Math.max(0, Math.min(1, (hue - HUE_MIN) / (HUE_MAX - HUE_MIN)));
      const hueIdx = Math.round(hueT * (HUE_COUNT - 1));
      const [cr, cg, cb] = hslToRgb(hue, 90, 62);

      ctx.clearRect(0, 0, vw, vh);

      // —— 星空层（最底层）：稀疏冷白星点，柔光呼吸闪烁 ——
      // 视差幅度比粒子小，示意它在更远处；亮度低，衬托中间粒子主体
      for (let i = 0; i < STAR_COUNT; i++) {
        const s = stars[i];
        const tw = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
        const a = s.base * (1 - s.tw + s.tw * tw);
        const dx = (((s.x + t * s.vx) % 1) + 1) % 1;
        const dy = (((s.y + t * s.vy) % 1) + 1) % 1;
        const sx = dx * vw + pmx * 6;
        const sy = dy * vh + pmy * 4;
        const [sr, sg, sb] = s.col;
        ctx.fillStyle = `rgba(${sr},${sg},${sb},${a})`;
        ctx.beginPath();
        ctx.arc(sx, sy, s.size, 0, Math.PI * 2);
        ctx.fill();
        if (s.flare) {
          const fl = a * 0.45;
          const len = s.size * 5;
          ctx.strokeStyle = `rgba(${sr},${sg},${sb},${fl})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(sx - len, sy);
          ctx.lineTo(sx + len, sy);
          ctx.moveTo(sx, sy - len);
          ctx.lineTo(sx, sy + len);
          ctx.stroke();
        }
      }

      // —— 流星：偶发划过，白青拖尾，短暂点缀 ——
      if (t >= nextMeteor && meteors.length < 2) {
        const fromLeft = Math.random() < 0.5;
        const mx0 = fromLeft ? vw * (0.08 + Math.random() * 0.3) : vw * (0.62 + Math.random() * 0.3);
        const my0 = vh * (0.04 + Math.random() * 0.22);
        const ang = (Math.PI / 2) * (0.15 + Math.random() * 0.2); // 斜向下
        const msp = 0.55 + Math.random() * 0.45;
        meteors.push({
          x: mx0,
          y: my0,
          vx: Math.cos(ang) * msp * (fromLeft ? 1 : -1),
          vy: Math.sin(ang) * msp,
          life: 0,
          maxLife: 1500 + Math.random() * 700,
        });
        nextMeteor = t + 7000 + Math.random() * 9000;
      }
      for (let m = meteors.length - 1; m >= 0; m--) {
        const mt = meteors[m];
        mt.x += mt.vx * dt;
        mt.y += mt.vy * dt;
        mt.life += dt;
        if (mt.life >= mt.maxLife || mt.x < -220 || mt.x > vw + 220 || mt.y > vh + 220) {
          meteors.splice(m, 1);
          continue;
        }
        const fade = Math.sin(Math.PI * Math.min(1, mt.life / mt.maxLife)); // 先亮后暗
        const sp2 = Math.hypot(mt.vx, mt.vy);
        const nx = -mt.vx / sp2, ny = -mt.vy / sp2;
        const tail = 130;
        for (let k = 0; k < 9; k++) {
          const seg = k / 9;
          ctx.strokeStyle = `rgba(210, 232, 255, ${(fade * (1 - seg) * 0.55).toFixed(3)})`;
          ctx.lineWidth = 1.6 * (1 - seg) + 0.3;
          ctx.beginPath();
          ctx.moveTo(mt.x + nx * tail * seg, mt.y + ny * tail * seg);
          ctx.lineTo(mt.x + nx * tail * (seg + 1 / 9), mt.y + ny * tail * (seg + 1 / 9));
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(255, 255, 255, ${(fade * 0.9).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(mt.x, mt.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // —— 第一遍：投影，缓存屏幕坐标与深度 ——
      // morph 中段的「散开」包络：过渡时粒子先散开再聚合，重组感更强
      const scatter = Math.sin(e * Math.PI) * 0.22;

      for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const x = from[ix] + (to[ix] - from[ix]) * e;
        const y = from[ix + 1] + (to[ix + 1] - from[ix + 1]) * e;
        const z = from[ix + 2] + (to[ix + 2] - from[ix + 2]) * e;

        // 呼吸微动（每粒子独立相位）+ 过渡散开：让点阵有生命感
        const wob = Math.sin(t * 0.0016 + i * 0.61) * 0.03;
        const bx = x + Math.cos(i * 1.3) * wob + Math.sin(i * 12.9898) * scatter;
        const by = y + Math.sin(i * 2.1) * wob + Math.cos(i * 7.3) * scatter;
        const bz = z + Math.sin(i * 0.7) * wob + Math.sin(i * 5.1) * scatter;

        const x1 = bx * cosY + bz * sinY;
        const z1 = -bx * sinY + bz * cosY;
        const y1 = by * cosX - z1 * sinX;
        const z2 = by * sinX + z1 * cosX;
        // 绕 Z（视线轴）翻转
        const x2 = x1 * cosZ - y1 * sinZ;
        const y2 = x1 * sinZ + y1 * cosZ;

        const persp = FOV / (FOV + z2 - zCam);
        sxArr[i] = pcx + x2 * persp * scale;
        syArr[i] = pcy + y2 * persp * scale;
        depthArr[i] = Math.min(1, Math.max(0, (persp - 0.68) / 1.2));
      }

      // —— 第二遍：连线（星座网络感，透明度随距离衰减）——
      const LINK = Math.max(70, Math.min(vw, vh) * 0.1);
      const LINK2 = LINK * LINK;
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgb(${cr},${cg},${cb})`;
      for (let i = 0; i < N; i++) {
        const xi = sxArr[i], yi = syArr[i];
        for (let j = i + 1; j < N; j++) {
          const dx = xi - sxArr[j];
          const dy = yi - syArr[j];
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK2) {
            const d = Math.sqrt(d2);
            ctx.globalAlpha = (1 - d / LINK) * 0.46;
            ctx.beginPath();
            ctx.moveTo(xi, yi);
            ctx.lineTo(sxArr[j], syArr[j]);
            ctx.stroke();
          }
        }
      }

      // —— 第三遍：画发光粒子 ——
      for (let i = 0; i < N; i++) {
        const depth = depthArr[i];
        const blurIdx = depth < 0.4 ? 0 : depth < 0.75 ? 1 : 2;
        const sp = sprites[hueIdx * 3 + blurIdx];
        const r = (1.3 + depth * 5) * sizeScale;
        ctx.globalAlpha = 0.32 + depth * 0.68;
        ctx.drawImage(sp, sxArr[i] - r, syArr[i] - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouse);
    };
  }, []);

  return <canvas ref={ref} className="morph" aria-hidden="true" />;
}
