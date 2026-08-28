"use client";

import { useMemo, useState } from "react";
import { Bell, ChevronRight, CircleAlert, Clock3, DatabaseZap, FileText, Filter, Mail, Menu, RefreshCw, Search, Settings2, SlidersHorizontal, Sparkles, X } from "lucide-react";
import type { AnalysisResult, BatchRun, BidNotice, Notification, ReviewState, Topic } from "@/lib/types";

type Tab = "dashboard" | "notices" | "notifications" | "operations";
type Props = { initialNotices: BidNotice[]; initialTopic: Topic; initialNotifications: Notification[]; initialRuns: BatchRun[]; userEmail: string; isAdmin: boolean };

const money = (value: number | null) => value ? `${(value / 100_000_000).toFixed(value >= 1_000_000_000 ? 1 : 2).replace(/\.0$/, "")}억원` : "금액 미정";
// The server renders in UTC while the public browser is typically KST.
// Pinning the display zone prevents a hydration mismatch in date text.
const time = (value: string) => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "확인 필요";
const daysLeft = (value: string) => value && !Number.isNaN(new Date(value).getTime()) ? Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000) : 0;
const scoreTone = (score: number) => score >= 85 ? "score-excellent" : score >= 70 ? "score-high" : score >= 50 ? "score-medium" : "score-low";
const pendingAnalysis: AnalysisResult = { score: 0, grade: "낮음", confidence: "낮음", eligibilityStatus: "확인 필요", summary: "아직 분석 결과가 생성되지 않았습니다.", components: [], positiveReasons: [], penalties: [], uncertainties: ["이번 수집분에서 첨부문서 키워드 근거가 확보되면 결과가 표시됩니다."] };

export function Dashboard({ initialNotices, initialTopic, initialNotifications, initialRuns, userEmail, isAdmin }: Props) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [notices, setNotices] = useState(initialNotices);
  const [topic, setTopic] = useState(initialTopic);
  const [runs, setRuns] = useState(initialRuns);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("전체");
  const [selected, setSelected] = useState<BidNotice | null>(null);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 수집 원본은 운영 지표에만 사용한다. 관리자도 결과 화면에서는
  // 첨부 근거까지 확보되어 분석이 완료된 공고만 확인한다.
  const visibleNotices = notices.filter((notice) => notice.analysis);

  const filtered = useMemo(() => notices.filter((notice) => notice.analysis)
    .filter((notice) => typeFilter === "전체" || notice.businessType === typeFilter)
    .filter((notice) => `${notice.title} ${notice.agency} ${notice.demandAgency}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (b.analysis?.score ?? 0) - (a.analysis?.score ?? 0) || new Date(a.closesAt).getTime() - new Date(b.closesAt).getTime()), [notices, query, typeFilter]);

  const eligible = visibleNotices.filter((notice) => notice.analysis && notice.analysis.score >= topic.threshold && notice.status !== "마감");

  const refreshData = async () => {
    const [noticeResponse, runResponse] = await Promise.all([fetch("/api/bids"), fetch("/api/runs")]);
    setNotices(await noticeResponse.json());
    setRuns(await runResponse.json());
  };

  const runAnalysis = async () => {
    setRunning(true);
    try {
      const response = await fetch("/api/runs", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "배치 실행에 실패했습니다.");
      await refreshData();
      setToast(`수집·분석 완료: 공고 ${result.discovered ?? 0}건, 분석 ${result.analyzed ?? 0}건`);
    } catch (error) { setToast(error instanceof Error ? error.message : "배치 실행에 실패했습니다."); }
    finally { setRunning(false); }
  };




  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><DatabaseZap size={19} /></div><span>BidFit</span></div>
        <p className="workspace-label">나라장터 분석 워크스페이스</p>
        <nav aria-label="주 메뉴">
          <NavItem active={tab === "dashboard"} icon={<Sparkles size={18} />} label="오늘의 공고" onClick={() => setTab("dashboard")} />
          <NavItem active={tab === "notices"} icon={<FileText size={18} />} label="전체 공고" onClick={() => setTab("notices")} />
          <NavItem active={false} icon={<Settings2 size={18} />} label="관리자 페이지" onClick={() => { window.location.href = "/admin"; }} />
          {isAdmin && <NavItem active={tab === "operations"} icon={<Settings2 size={18} />} label="운영 현황" onClick={() => setTab("operations")} />}
        </nav>
        <div className="sidebar-bottom"><div className="profile-avatar">{isAdmin ? "관" : "사"}</div><div><strong>{userEmail}</strong><small>{isAdmin ? "관리자" : "열람 사용자"}</small></div></div>
      </aside>

      <section className="content">
        <header className="topbar"><button className="icon-button mobile-menu" aria-label="메뉴"><Menu size={20} /></button><div className="crumb">나라장터 입찰공고 <ChevronRight size={15} /> <strong>{tab === "dashboard" ? "오늘의 분석" : tab === "notices" ? "전체 공고" : tab === "operations" ? "운영 현황" : "전체 공고"}</strong></div><div className="topbar-right"><span className="data-pill"><span className="live-dot" />나라장터 연계</span></div></header>
        {tab === "dashboard" && <Overview notices={visibleNotices} eligible={eligible} topic={topic} onOpen={setSelected} onShowAll={() => setTab("notices")} isAdmin={isAdmin} latestRun={runs[0]} previousRun={runs.find((run) => run.status === "완료")} />}
        {tab === "notices" && <NoticeList notices={filtered} query={query} typeFilter={typeFilter} onQuery={setQuery} onType={setTypeFilter} onOpen={setSelected} />}
        {tab === "operations" && isAdmin && <Operations runs={runs} notices={notices} />}
      </section>
      {selected && <NoticeDrawer notice={selected} onClose={() => setSelected(null)} onReview={() => undefined} isAdmin={false} />}
      {toast && <div className="toast"><Sparkles size={18} />{toast}<button onClick={() => setToast(null)} aria-label="닫기"><X size={16} /></button></div>}
    </main>
  );
}

function NavItem({ active, icon, label, badge, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{badge && <em>{badge}</em>}</button>;
}

function Overview({ notices, eligible, topic, onOpen, onShowAll, isAdmin, latestRun, previousRun }: { notices: BidNotice[]; eligible: BidNotice[]; topic: Topic; onOpen: (notice: BidNotice) => void; onShowAll: () => void; isAdmin: boolean; latestRun?: BatchRun; previousRun?: BatchRun }) {
  const isRunning = latestRun?.status === "실행 중" || latestRun?.status === "분석 중";
  // `notices` is already the atomically published snapshot from the server.
  // During a running or partial batch, the latest run's counters describe
  // unfinished work, so never use them to overwrite the visible snapshot.
  const previousCompleted = latestRun?.status === "완료" ? latestRun : previousRun;
  const hasPublishedResult = Boolean(previousCompleted);
  const high = notices.filter((item) => (item.analysis?.score ?? 0) >= 85).length;
  const analyzed = hasPublishedResult ? notices.length : "-";
  const changed = notices.filter((item) => item.status === "정정" || item.status === "재공고").length;
  const isPartial = latestRun?.status === "부분 완료";
  const statusText = !latestRun
    ? "첫 정기 업데이트 전입니다. 결과가 준비되면 공고를 표시합니다."
    : isRunning
      ? `${previousCompleted ? "새 결과를 준비하고 있습니다. 이전 결과를 표시합니다." : "첫 결과를 준비하고 있습니다. 완료되면 공고를 표시합니다."}`
      : isPartial
        ? `이번 업데이트를 끝까지 마치지 못했습니다. ${latestRun.errorSummary ? `사유: ${latestRun.errorSummary}` : "이전 결과를 표시합니다."}`
          : latestRun.analyzed > 0
          ? `오늘 ${time(latestRun.completedAt ?? latestRun.startedAt)} 업데이트가 완료되었습니다. ${latestRun.discovered}건을 수집하고 ${latestRun.analyzed}건의 첨부문서·공고 내용 분석을 완료했습니다.`
          : latestRun.discovered > 0
            ? `오늘 ${time(latestRun.completedAt ?? latestRun.startedAt)} ${latestRun.discovered}건을 수집했습니다. 첨부문서 분석 결과가 아직 없어 점수를 표시하지 않습니다.`
            : "오늘 나라장터에서 새로 확인할 공고가 없었습니다.";
  const windowLabel = latestRun?.windowHours ? `최근 ${latestRun.windowHours}시간` : "분석 단위시간";
  return <div className="page-content">
    <section className="title-row"><div><p className="eyebrow">매일 08:00~09:00 KST 정기 업데이트</p><h1>오늘의 입찰 기회</h1><p className="lede">{windowLabel}의 용역 공고를 분석하고, <strong>{topic.name}</strong>와 가까운 공고를 우선 추천합니다.</p></div></section>
    <section className={`batch-status ${isRunning ? "running" : isPartial ? "failed" : "complete"}`}><div><strong>{isRunning ? "오늘의 분석 진행 중" : isPartial ? "오늘의 업데이트 확인 필요" : "오늘의 분석 결과"}</strong><p>{statusText}</p></div><span>{latestRun?.status ?? "대기"}</span></section>
    <section className="metric-grid">
      <Metric icon={<FileText />} value={analyzed} label="분석 완료 공고" note="첨부문서 근거 확보 후 표시" />
      <Metric icon={<Clock3 />} value={latestRun?.status === "완료" ? latestRun.discovered : (previousCompleted?.discovered ?? "-")} label={latestRun?.status === "완료" ? "이번 업데이트 수집" : "이전 업데이트 수집"} note={latestRun?.status === "완료" ? `${windowLabel} 분석 구간` : "새 결과 준비 전까지 표시"} tone="orange" />
      <Metric icon={<Sparkles />} value={eligible.length} label={`${topic.threshold}점 이상 추천`} note={`관심 주제: ${topic.name}`} tone="blue" />
      <Metric icon={<Clock3 />} value={high} label="우선 검토 공고" note="85점 이상 · 매우 높음" tone="green" />
      <Metric icon={<CircleAlert />} value={changed} label="정정·재공고" note="변경 내용을 확인하세요" tone="orange" />
    </section>
    <section className="section-head"><div><h2>우선 검토 추천</h2><p>점수와 마감 임박도를 기준으로 정렬했습니다.</p></div><button className="text-button" onClick={onShowAll}>전체 공고 보기 <ChevronRight size={16} /></button></section>
    <section className="notice-grid">{eligible.slice(0, 3).map((notice) => <NoticeCard key={notice.id} notice={notice} onOpen={() => onOpen(notice)} />)}</section>
    <section className="insight-panel"><div className="insight-icon"><Mail size={20} /></div><div><h3>{analyzed ? "원문 확인 안내" : "현재 추천 공고 없음"}</h3><p>{analyzed ? `추천 공고 ${eligible.length}건을 확인할 수 있습니다. 적합도는 검토 보조 정보이므로 입찰 전 나라장터 원문과 첨부문서를 반드시 확인하세요.` : isRunning ? "분석이 완료되면 이곳에 주제와 유사한 공고만 표시됩니다." : "이번 업데이트에서 분석 완료된 유사 공고가 없습니다. 다음 정기 업데이트는 내일 08:00~09:00 KST에 진행됩니다."}</p></div><span className="preview-chip">검토 보조</span></section>
  </div>;
}

function Metric({ icon, value, label, note, tone = "" }: { icon: React.ReactNode; value: number | string; label: string; note: string; tone?: string }) { return <article className={`metric-card ${tone}`}><div className="metric-icon">{icon}</div><strong>{value}</strong><span>{label}</span><small>{note}</small></article>; }

function NoticeCard({ notice, onOpen }: { notice: BidNotice; onOpen: () => void }) {
  const analysis = notice.analysis!;
  return <article className="notice-card"><div className="card-top"><span className={`score-chip ${scoreTone(analysis.score)}`}>{analysis.score}<small>점</small></span><div className="card-tags"><span className={`status-tag ${notice.status}`}>{notice.status}</span><span className="type-tag">{notice.businessType}</span></div></div><h3>{notice.title}</h3><p className="agency">{notice.demandAgency}</p><div className="facts"><span>{money(notice.budget)}</span><span>마감 D-{Math.max(0, daysLeft(notice.closesAt))}</span></div><p className="reason"><Sparkles size={15} />{analysis.positiveReasons[0]?.text}</p><div className="card-footer"><span className={`eligibility ${analysis.eligibilityStatus.replace(" ", "-")}`}>{analysis.eligibilityStatus}</span><button className="text-button" onClick={onOpen}>상세 분석 <ChevronRight size={16} /></button></div></article>;
}

function NoticeList({ notices, query, typeFilter, onQuery, onType, onOpen }: { notices: BidNotice[]; query: string; typeFilter: string; onQuery: (value: string) => void; onType: (value: string) => void; onOpen: (notice: BidNotice) => void }) {
  return <div className="page-content"><section className="title-row compact"><div><p className="eyebrow">검색 및 우선순위 확인</p><h1>분석 완료 공고</h1><p className="lede">첨부문서·공고 내용 분석이 끝난 용역 공고만 표시합니다.</p></div></section><div className="filters"><label className="search"><Search size={18} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="공고명, 기관명 검색" /></label><label className="select"><Filter size={17} /><select value={typeFilter} onChange={(event) => onType(event.target.value)}><option>전체</option><option>용역</option></select></label></div><div className="table-wrap"><table><thead><tr><th>적합도</th><th>공고</th><th>기관</th><th>예산</th><th>마감</th><th>상태</th><th /></tr></thead><tbody>{notices.map((notice) => <tr key={notice.id}><td><span className={`score-chip small ${scoreTone(notice.analysis?.score ?? 0)}`}>{notice.analysis?.score}</span></td><td><button className="title-link" onClick={() => onOpen(notice)}>{notice.title}<small>{notice.bidNumber}-{notice.order} · {notice.businessType}</small></button></td><td>{notice.demandAgency}</td><td>{money(notice.budget)}</td><td><strong className={daysLeft(notice.closesAt) < 3 ? "urgent" : ""}>{notice.status === "마감" ? "마감" : notice.closesAt ? `D-${daysLeft(notice.closesAt)}` : "확인 필요"}</strong><small>{time(notice.closesAt)}</small></td><td><span className={`status-tag ${notice.status}`}>{notice.status}</span></td><td><div className="table-actions">{notice.detailUrl && notice.detailUrl !== "https://www.g2b.go.kr" && <a className="icon-button table-button" href={notice.detailUrl} target="_blank" rel="noreferrer" aria-label="나라장터 원문 열기">원문</a>}<button className="icon-button table-button" onClick={() => onOpen(notice)} aria-label="상세 보기"><ChevronRight size={18} /></button></div></td></tr>)}</tbody></table>{notices.length === 0 && <div className="empty-state">아직 분석 완료된 용역 공고가 없습니다.</div>}</div></div>;
}

function TopicForm({ topic, onSave }: { topic: Topic; onSave: (event: React.FormEvent<HTMLFormElement>) => void }) { return <div className="page-content narrow"><section className="title-row compact"><div><p className="eyebrow">추천 기준과 분석 가중치</p><h1>관심 주제 설정</h1><p className="lede">현재 주제는 모든 공고의 적합도와 알림 기준에 즉시 반영됩니다.</p></div></section><form className="topic-form" onSubmit={onSave}><label>주제명<input name="name" defaultValue={topic.name} required /></label><label className="full">원하는 사업 설명<textarea name="description" defaultValue={topic.description} rows={3} required /></label><label className="full">보유 역량<textarea name="capabilities" defaultValue={topic.capabilities} rows={2} /></label><label>포함 키워드 <small>쉼표로 구분</small><input name="includeKeywords" defaultValue={topic.includeKeywords.join(", ")} /></label><label>제외 키워드 <small>쉼표로 구분</small><input name="excludeKeywords" defaultValue={topic.excludeKeywords.join(", ")} /></label><label>최소 검토 기간<input name="minimumDays" type="number" min="0" defaultValue={topic.minimumDays} /><small>마감까지 필요한 최소 일수</small></label><label>알림 기준 점수<input name="threshold" type="number" min="0" max="100" defaultValue={topic.threshold} /><small>이 점수 이상 공고를 알립니다.</small></label><div className="form-note full"><CircleAlert size={18} /><span>입찰 참가 자격은 적합도와 별도로 표시됩니다. 반드시 원 공고와 첨부문서를 확인하세요.</span></div><div className="form-actions full"><button type="submit" className="primary-button">변경사항 저장</button></div></form></div>; }

function Notifications({ items, notices, onRead, onOpen, isAdmin }: { items: Notification[]; notices: BidNotice[]; onRead: (id: string) => void; onOpen: (notice: BidNotice) => void; isAdmin: boolean }) { return <div className="page-content narrow"><section className="title-row compact"><div><p className="eyebrow">웹 알림</p><h1>알림 센터</h1></div></section>{items.length ? <div className="notification-list">{items.map((item) => { const notice = notices.find((candidate) => candidate.id === item.bidId); return <article key={item.id} className={`notification-item ${item.read ? "read" : ""}`}><span className={`score-chip small ${scoreTone(item.score)}`}>{item.score}</span><div><p className="notification-meta">분석 결과 · {time(item.createdAt)}</p><h3>{item.title}</h3><p>{item.message}</p><button className="text-button" onClick={() => notice && onOpen(notice)}>공고 상세 보기 <ChevronRight size={15} /></button></div>{isAdmin && !item.read && <button className="read-button" onClick={() => onRead(item.id)}>읽음 표시</button>}</article>; })}</div> : <div className="empty-state">아직 생성된 알림이 없습니다.</div>}</div>; }

function Operations({ runs, notices }: { runs: BatchRun[]; notices: BidNotice[] }) { const success = notices.flatMap((item) => item.attachments).filter((item) => item.status === "분석 완료").length; const incomplete = notices.flatMap((item) => item.attachments).filter((item) => item.status !== "분석 완료").length; return <div className="page-content"><section className="title-row compact"><div><p className="eyebrow">GitHub Actions · 나라장터 API</p><h1>운영 현황</h1><p className="lede">매일 오전 8시(KST)부터 실행시각 기준 최근 24시간의 공고를 수집·문서 추출·Gemini 분석합니다.</p></div></section><div className="operation-grid"><article><span>첨부 원문 분석 완료</span><strong>{success}</strong><small>TXT 변환과 Gemini 분석 근거가 확보된 문서</small></article><article><span>분석 미완료·보류 문서</span><strong>{incomplete}</strong><small>지원하지 않는 형식, 10MB 초과, 다운로드·텍스트 추출 실패 포함</small></article><article><span>최근 분석 구간</span><strong>{runs[0]?.windowHours ? `${runs[0].windowHours}시간` : "-"}</strong><small>모든 실행은 최근 24시간으로 고정</small></article></div><section className="section-head"><div><h2>최근 실행</h2><p>정기 실행이 저장한 시각과 분석 구간입니다.</p></div></section><div className="table-wrap"><table><thead><tr><th>실행 시각</th><th>상태</th><th>분석 구간</th><th>발견</th><th>변경</th><th>분석</th><th>API 호출</th></tr></thead><tbody>{runs.length ? runs.map((run) => <tr key={run.id}><td>{time(run.startedAt)}</td><td><span className="status-tag 신규">{run.status}</span></td><td>{run.windowHours ? `최근 ${run.windowHours}시간` : "기록 없음"}</td><td>{run.discovered}</td><td>{run.changed}</td><td>{run.analyzed}</td><td>{run.apiCalls}</td></tr>) : <tr><td colSpan={7} className="muted-cell">아직 자동 실행 이력이 없습니다.</td></tr>}</tbody></table></div></div>; }

function NoticeDrawer({ notice, onClose, onReview, isAdmin }: { notice: BidNotice; onClose: () => void; onReview: (notice: BidNotice, state: ReviewState) => void; isAdmin: boolean }) { const analysis = notice.analysis ?? pendingAnalysis; return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}><aside className="drawer" role="dialog" aria-modal="true" aria-label="공고 상세" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-head"><div><span className={`status-tag ${notice.status}`}>{notice.status}</span><span className="type-tag">{notice.businessType}</span></div><button className="icon-button" onClick={onClose} aria-label="닫기"><X size={20} /></button></div><div className="drawer-title"><span className={`score-chip ${scoreTone(analysis.score)}`}>{analysis.score}<small>점</small></span><div><p>{analysis.grade} · 신뢰도 {analysis.confidence}</p><h2>{notice.title}</h2></div></div><div className="drawer-scroll"><section className="detail-facts"><div><span>수요기관</span><strong>{notice.demandAgency}</strong></div><div><span>예산</span><strong>{notice.budgetLabel}</strong></div><div><span>마감</span><strong>{time(notice.closesAt)} {notice.status !== "마감" && `(D-${daysLeft(notice.closesAt)})`}</strong></div><div><span>계약 방식</span><strong>{notice.contractMethod}</strong></div></section><section><h3>분석 요약</h3><p>{analysis.summary}</p></section><section><h3>적합도 구성</h3><div className="component-list">{analysis.components.map((component) => <div key={component.name}><div><span>{component.name}</span><strong>{component.score}/{component.maxScore}</strong></div><span className="bar"><i style={{ width: `${component.score / component.maxScore * 100}%` }} /></span></div>)}</div></section><section><h3>적합 근거</h3>{analysis.positiveReasons.map((reason, index) => <article className="evidence" key={index}><Sparkles size={17} /><div><strong>{reason.label}</strong><p>{reason.text}</p><small>{reason.source} · {reason.location}</small></div></article>)}</section><section><h3>과업 범위</h3><ul>{notice.tasks.map((task) => <li key={task}>{task}</li>)}</ul></section><section><h3>참가 조건</h3><span className={`eligibility ${analysis.eligibilityStatus.replace(" ", "-")}`}>{analysis.eligibilityStatus}</span><ul>{notice.qualifications.map((item) => <li key={item}>{item}</li>)}</ul>{analysis.uncertainties.map((item) => <p className="warning" key={item}><CircleAlert size={16} />{item}</p>)}</section><section><h3>감점·주의 요인</h3>{analysis.penalties.length ? <ul>{analysis.penalties.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">주요 감점 요인이 없습니다.</p>}</section><section><h3>첨부문서 분석</h3>{notice.attachments.map((item) => <div className="attachment" key={item.id}><FileText size={17} /><span>{item.name}<small>{item.kind}{item.pages ? ` · ${item.pages}p` : ""}</small></span><em className={item.status.replace(" ", "-")}>{item.status}</em></div>)}</section>{isAdmin && <section><h3>검토 상태</h3><div className="review-actions">{(["검토 전", "검토 중", "참여", "미참여", "보관"] as ReviewState[]).map((state) => <button key={state} onClick={() => onReview(notice, state)} className={notice.reviewState === state ? "selected" : ""}>{state}</button>)}</div></section>}</div></aside></div>; }
