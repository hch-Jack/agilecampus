"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { registerAction, type FormState } from "./actions";
import { AuthBackground, AuthBrand, AuthHero, EyeIcon } from "../auth-shared";
import "../auth.css";

export default function RegisterPage() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    registerAction,
    null,
  );
  const [showPw, setShowPw] = useState(false);

  return (
    <div className="auth">
      <AuthBackground />
      <AuthBrand />

      <main className="wrap">
        <AuthHero
          kicker="JOIN THE CAMPUS"
          title="加入我们"
          ename="Create account"
          slogan="Start agile, stay serene."
          sloganCn="成为敏捷校园的一员，开始从容协作。"
        />

        <section className="card">
          <h2>创建账号</h2>
          <p className="card-sub">几步注册，即可加入团队开始协作。</p>

          <form action={formAction}>
            <div className="field">
              <label htmlFor="name">用户名</label>
              <input
                id="name"
                name="name"
                placeholder="你的用户名（全站唯一）"
                className="input"
                autoComplete="username"
              />
              <p className="field-hint">注册后全站唯一，别人搜这个名字就能给你发消息。</p>
            </div>

            {/* 身份决定加入团队时的初始角色：导师→只读观察，学生→可写任务 */}
            <div className="field">
              <label htmlFor="identity">身份</label>
              <select id="identity" name="identity" defaultValue="" className="input">
                <option value="" disabled>
                  导师 / 学生
                </option>
                <option value="teacher">导师</option>
                <option value="student">学生</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="email">邮箱</label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="you@campus.edu"
                className="input"
                autoComplete="email"
              />
            </div>

            <div className="field">
              <label htmlFor="password">密码</label>
              <span className="pw">
                <input
                  id="password"
                  name="password"
                  type={showPw ? "text" : "password"}
                  placeholder="至少 8 位"
                  className="input"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="eye"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? "隐藏密码" : "显示密码"}
                >
                  <EyeIcon off={!showPw} />
                </button>
              </span>
            </div>

            {state?.error && <p className="msg-err">{state.error}</p>}

            <button type="submit" disabled={pending} className="submit">
              {pending ? "注册中…" : "注册"}
            </button>
          </form>

          <p className="switch">
            已有账号？<Link href="/login">去登录</Link>
          </p>
        </section>
      </main>
    </div>
  );
}
