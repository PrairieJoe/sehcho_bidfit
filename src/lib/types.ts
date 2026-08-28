export type BusinessType = "용역" | "물품" | "공사" | "외자";
export type Confidence = "높음" | "보통" | "낮음";
export type EligibilityStatus = "충족 가능" | "확인 필요" | "조건 불일치";
export type NoticeStatus = "신규" | "정정" | "재공고" | "마감";
export type ReviewState = "검토 전" | "검토 중" | "참여" | "미참여" | "보관";

export interface Topic {
  id: string;
  name: string;
  description: string;
  capabilities: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  businessTypes: BusinessType[];
  regions: string[];
  minBudget: number | null;
  maxBudget: number | null;
  minimumDays: number;
  threshold: number;
}

export interface Attachment {
  id: string;
  name: string;
  kind: string;
  status: "대기" | "처리 중" | "보류" | "분석 완료" | "부분 분석" | "추출 실패" | "다운로드 실패";
  pages?: number;
  sourceUrl?: string;
  storagePath?: string;
  extractedText?: string;
  failureReason?: string;
}

export interface Evidence {
  label: string;
  text: string;
  source: string;
  location: string;
}

export interface ScoreComponent {
  name: string;
  score: number;
  maxScore: number;
}

export interface AnalysisResult {
  score: number;
  grade: "매우 높음" | "높음" | "보통" | "낮음";
  confidence: Confidence;
  eligibilityStatus: EligibilityStatus;
  summary: string;
  components: ScoreComponent[];
  positiveReasons: Evidence[];
  penalties: string[];
  uncertainties: string[];
  aiModel?: string;
  promptVersion?: string;
}

export interface BidNotice {
  id: string;
  bidNumber: string;
  order: string;
  title: string;
  businessType: BusinessType;
  status: NoticeStatus;
  agency: string;
  demandAgency: string;
  region: string;
  publishedAt: string;
  closesAt: string;
  budget: number | null;
  budgetLabel: string;
  contractMethod: string;
  detailUrl: string;
  description: string;
  tasks: string[];
  qualifications: string[];
  changeSummary?: string;
  attachments: Attachment[];
  analysis?: AnalysisResult;
  reviewState: ReviewState;
  memo?: string;
}

export interface Notification {
  id: string;
  bidId: string;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  score: number;
}

export interface BatchRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: "완료" | "실행 중" | "분석 중" | "부분 완료";
  discovered: number;
  changed: number;
  analyzed: number;
  notified: number;
  apiCalls: number;
  windowStart?: string;
  windowEnd?: string;
  windowHours?: number;
  errorSummary?: string;
}

export interface BidSource {
  listNotices(windowStart: Date, windowEnd: Date): Promise<BidNotice[]>;
  countNotices?(windowStart: Date, windowEnd: Date): Promise<number>;
}

export interface AnalysisEngine {
  analyze(notice: BidNotice, topic: Topic): AnalysisResult;
}

export interface NotificationProvider {
  create(notice: BidNotice, analysis: AnalysisResult): Notification;
}
