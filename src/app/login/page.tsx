"use client";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState(""); const [message, setMessage] = useState(""); const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setLoading(true); const response = await fetch("/api/auth/magic-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }); const payload = await response.json(); setMessage(payload.message); setLoading(false); }
  return <main className="login-shell"><section className="login-card"><p className="eyebrow">BIDFIT · INVITED BETA</p><h1>나라장터 입찰 적합도 분석</h1><p>초대받은 이메일로 로그인 링크를 받으세요.</p><form onSubmit={submit}><label htmlFor="email">이메일</label><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="name@example.com" /><button disabled={loading}>{loading ? "전송 중…" : "매직링크 받기"}</button></form>{message && <p role="status">{message}</p>}</section></main>;
}
