import type { Topic } from "@/lib/types";

export const defaultTopic: Omit<Topic, "id"> = {
  name: "대중교통 체계 개편",
  description: "대중교통 노선·환승·요금·수요 분석을 바탕으로 시민 이동 편의와 운영 효율을 개선하는 사업",
  capabilities: "교통 데이터 분석, 수요 예측, 노선 설계, 시민 의견 조사",
  includeKeywords: ["대중교통", "노선", "환승", "교통체계", "수요", "버스", "운영개편"],
  excludeKeywords: ["청소", "경비", "시설물 유지관리"],
  businessTypes: ["용역"], regions: ["전국"], minBudget: null, maxBudget: null, minimumDays: 3, threshold: 70,
};
