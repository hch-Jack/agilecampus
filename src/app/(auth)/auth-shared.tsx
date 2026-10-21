"use client";

import { ParticleMorph } from "./particle-morph";

// 登录 / 注册共用的深空背景层：发光粒子矩阵 morph + 遮罩压暗
export function AuthBackground() {
  return (
    <>
      <div className="aurora" />
      <ParticleMorph />
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
      <div className="shade" />
    </>
  );
}

// 左上品牌
export function AuthBrand() {
  return (
    <div className="brand">
      <div className="mark">A</div>
      <div className="name">
        <b>AgileCampus</b> · 敏捷校园
      </div>
    </div>
  );
}

// 四角星（sparkle 星芒）
export function Spark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0c.9 6.5 5.5 11.1 12 12-6.5.9-11.1 5.5-12 12-.9-6.5-5.5-11.1-12-12C6.5 11.1 11.1 6.5 12 0Z" />
    </svg>
  );
}

// 左栏标题区（星环弧线 + 流星 + 四角星装饰）
export function AuthHero({
  kicker,
  title,
  ename,
  slogan,
  sloganCn,
}: {
  kicker?: string;
  title: string;
  ename?: string;
  slogan?: string;
  sloganCn?: string;
}) {
  return (
    <section className="hero">
      {/* 流星：沿星环周期性快速划过 */}
      <span className="hero-comet" aria-hidden />

      <p className="kicker">{kicker ?? "AGILE CAMPUS"}</p>
      <h1 className="title">
        <span className="title-inner">
          <span className="title-text" data-text={title}>
            {title}
            <Spark className="spark spark-a" />
            <Spark className="spark spark-b" />
          </span>
        </span>
      </h1>
      {ename && (
        <p className="ename">
          <span className="ename-inner">
            {ename}
            <Spark className="spark spark-c" />
          </span>
        </p>
      )}
      <div className="divider" />
      {slogan && <p className="slogan">{slogan}</p>}
      {sloganCn && <p className="slogan-cn">{sloganCn}</p>}
    </section>
  );
}

// 密码显隐眼睛图标（off=true 表示当前隐藏、显示「睁眼」）
export function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {off ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17.5 17.5 0 0 1-3.1 4" />
          <path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.1-.9" />
        </>
      ) : (
        <>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
          <circle cx="12" cy="12" r="2.6" />
        </>
      )}
    </svg>
  );
}
