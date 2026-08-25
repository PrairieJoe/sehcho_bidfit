# BidFit MVP

나라장터 입찰공고를 관심 주제와 비교해 점수·근거·참가조건을 보여주는 로컬 MVP입니다. 기본 주제는 **대중교통 체계 개편**이며, 외부 키가 없어도 모의 공고로 전체 흐름을 검증할 수 있습니다.

## 실행

이 프로젝트는 Codex가 제공하는 번들 Node.js 또는 일반 Node.js LTS(20 이상)에서 실행할 수 있습니다.

```powershell
pnpm install
pnpm dev
```

브라우저에서 `http://localhost:3002`을 엽니다. 기본 포트는 다른 로컬 프로젝트와 충돌하지 않도록 3002로 지정되어 있습니다. `오늘 분석 실행`을 누르면 전일 72시간 중첩 조회를 가정한 모의 수집·점수화·앱 알림 흐름이 실행됩니다.

Codex Desktop의 번들 런타임을 쓰는 현재 환경에서는 다음 명령으로 Node.js 경로를 자동 설정해 실행할 수 있습니다.

```powershell
.\scripts\dev.ps1
```

## 테스트와 빌드

```powershell
pnpm test
pnpm build
```

## 구성

- `src/lib/sources.ts`: `BidSource` 공급자 계약과 Mock/나라장터 전환 지점
- `src/lib/analysis.ts`: 설명 가능한 규칙 기반 적합도 분석기
- `src/lib/store.ts`: 자격증명 없는 로컬 메모리 저장소 및 배치 실행 흐름
- `src/lib/supabase.ts`: Supabase 환경변수 기반 선택적 클라이언트
- `src/lib/email.ts`: 앱 알림/이메일 미리보기 공급자 경계
- `src/app/api`: 공고, 주제, 수동 분석, 알림, 이메일 미리보기 API

## 환경변수

`.env.example`을 `.env.local`로 복사한 뒤 필요한 값만 채웁니다. 모든 값이 비어 있으면 Mock 데이터 모드입니다.

| 변수 | 용도 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 인증·DB 연결 |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버측 관리 작업 |
| `NARAJANGTEO_SERVICE_KEY` | 나라장터 OpenAPI 호출 |
| `OPENAI_API_KEY` | AI 요약·근거 보강 |
| `RESEND_API_KEY`, `EMAIL_FROM` | 이메일 발송 |

## 운영 전환 체크리스트

1. 공공데이터포털에서 나라장터 입찰공고정보서비스 인증키를 발급받고, 최신 OpenAPI 응답 필드를 검증합니다.
2. `NarajangteoBidSource`에 물품·용역·공사·외자별 목록/상세/변경·첨부 호출을 구현합니다.
3. Supabase에 공고, 공고버전, 첨부, 분석, 점수, 알림, 배치 이력 테이블과 RLS 정책을 적용합니다.
4. 실제 문서 다운로드·악성 파일 검사·PDF/HWP/HWPX 추출·OCR 워커를 추가합니다.
5. OpenAI 분석기와 Resend/SMTP 이메일 공급자를 연결합니다.
6. 09:00 KST 스케줄러와 재시도/관측성·비용 한도를 운영 환경에 구성합니다.

> 이 서비스의 점수와 자격 상태는 검토 보조 정보입니다. 실제 입찰 참가 전에는 나라장터 원문 공고 및 첨부문서를 반드시 확인해야 합니다.
