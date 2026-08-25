import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BidFit | 나라장터 입찰 분석",
  description: "나라장터 입찰공고 주제 적합도 분석 MVP",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
