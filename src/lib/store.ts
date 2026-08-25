import { RuleAnalysisEngine } from "@/lib/analysis";
import { mockNotices, starterTopic } from "@/lib/mock-data";
import { MockBidSource } from "@/lib/sources";
import type { BatchRun, BidNotice, Notification, ReviewState, Topic } from "@/lib/types";

type MemoryState = { topic: Topic; notices: BidNotice[]; notifications: Notification[]; runs: BatchRun[] };
const state: MemoryState = { topic: structuredClone(starterTopic), notices: structuredClone(mockNotices), notifications: [], runs: [] };
const analyzer = new RuleAnalysisEngine();

const hydrate = () => {
  state.notices = state.notices.map((notice) => ({ ...notice, analysis: analyzer.analyze(notice, state.topic) }));
};
hydrate();

export const repository = {
  getTopic: () => structuredClone(state.topic),
  updateTopic: (patch: Partial<Topic>) => {
    state.topic = { ...state.topic, ...patch };
    hydrate();
    return structuredClone(state.topic);
  },
  listNotices: () => structuredClone(state.notices),
  getNotice: (id: string) => structuredClone(state.notices.find((notice) => notice.id === id)),
  updateNotice: (id: string, patch: Pick<BidNotice, "reviewState" | "memo">) => {
    const notice = state.notices.find((item) => item.id === id);
    if (!notice) return undefined;
    Object.assign(notice, patch);
    return structuredClone(notice);
  },
  listNotifications: () => structuredClone(state.notifications),
  markNotificationRead: (id: string) => {
    const notification = state.notifications.find((item) => item.id === id);
    if (notification) notification.read = true;
    return structuredClone(notification);
  },
  listRuns: () => structuredClone(state.runs),
  runDailyAnalysis: async () => {
    const startedAt = new Date().toISOString();
    const source = new MockBidSource();
    const notices = await source.listNotices(new Date(Date.now() - 72 * 60 * 60 * 1000), new Date());
    let notified = 0;
    notices.forEach((incoming) => {
      const existing = state.notices.find((notice) => notice.id === incoming.id);
      const notice = existing ?? incoming;
      if (!existing) state.notices.push(notice);
      notice.analysis = analyzer.analyze(notice, state.topic);
      const eventKey = `analysis-${notice.id}-${notice.analysis.score}`;
      if (notice.analysis.score >= state.topic.threshold && notice.status !== "마감" && !state.notifications.some((item) => item.id === eventKey)) {
        state.notifications.unshift({ id: eventKey, bidId: notice.id, title: notice.title, score: notice.analysis.score, message: `${state.topic.name} 주제와 높은 관련성이 확인되었습니다.`, createdAt: new Date().toISOString(), read: false });
        notified += 1;
      }
    });
    const run: BatchRun = { id: `run-${Date.now()}`, startedAt, completedAt: new Date().toISOString(), status: "완료", discovered: notices.length, changed: notices.filter((item) => item.status === "정정" || item.status === "재공고").length, analyzed: notices.length, notified, apiCalls: 4 };
    state.runs.unshift(run);
    return structuredClone(run);
  },
};
