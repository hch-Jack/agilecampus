"use client";

import { Suspense, useActionState, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { loginAction, type FormState } from "./actions";
import { FeishuLogin } from "./feishu-login";
import { AuthBackground, AuthBrand, AuthHero, EyeIcon } from "../auth-shared";
import "../auth.css";

function LoginForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    loginAction,
    null,
  );
  const registered = useSearchParams().get("registered");
  const [showPw, setShowPw] = useState(false);

  return (
    <div className="auth">
      <AuthBackground />
      <AuthBrand />

      <main className="wrap">
        <AuthHero
          title="敏捷校园"
          ename="AgileCampus"
          slogan="Agility, made serene."
          sloganCn="让校园团队的每一次协作，从容而优雅。"
        />

        <section className="card">
          <h2>欢迎回来</h2>
          <p className="card-sub">登录后继续你的项目与团队协作。</p>

          {registered && <p className="msg-ok">注册成功，请登录。</p>}

          <form action={formAction}>
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
                  placeholder="••••••••"
                  className="input"
                  autoComplete="current-password"
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
              {pending ? "登录中…" : "登录"}
            </button>
          </form>

          <div className="feishu">
            <FeishuLogin />
          </div>

          <p className="switch">
            没有账号？<Link href="/register">去注册</Link>
          </p>
        </section>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
