# BidFit MVP

나라장터 입찰공고를 관심 주제와 비교해 점수·근거·참가조건을 보여주는 초대 사용자용 공개 베타입니다. 실제 Supabase와 나라장터 API가 필수이며, 로컬 모의 공고 모드는 제공하지 않습니다.

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

- `src/lib/sources.ts`: 나라장터 입찰공고 API 수집 어댑터
- `src/lib/analysis.ts`: 설명 가능한 규칙 기반 적합도 분석기
- `src/lib/store.ts`: 자격증명 없는 로컬 메모리 저장소 및 배치 실행 흐름
- `src/lib/supabase.ts`: Supabase 환경변수 기반 선택적 클라이언트
- `src/lib/email.ts`: 앱 알림/이메일 미리보기 공급자 경계
- `src/app/api`: 공고, 주제, 수동 분석, 알림, 이메일 미리보기 API

## 환경변수

`.env.example`을 `.env.local`로 복사한 뒤 모든 필수 값을 채웁니다. 이 서비스는 Supabase와 나라장터 API 키가 없는 상태로는 실행되지 않습니다.

| 변수 | 용도 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 인증·DB 연결 |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버측 관리 작업 |
| `ADMIN_ACCESS_CODE` | 관리자 페이지 접근 코드(서버 환경변수 전용) |
| `NARAJANGTEO_SERVICE_KEY` | 나라장터 OpenAPI 호출 |
| `NEXT_PUBLIC_SITE_URL` | 매직링크가 돌아올 배포 URL |
| `CRON_SECRET` | Vercel Cron 호출 검증용 비밀값 |

## Supabase + Vercel 공개 베타 설정

1. Supabase 프로젝트를 만들고 SQL Editor에서 [초기 migration](./supabase/migrations/202608250001_initial_schema.sql)과 [관리자 쓰기 제한 migration](./supabase/migrations/202608250002_admin_only_writes.sql)을 순서대로 실행합니다.
2. Supabase Authentication의 URL Configuration에 `https://배포도메인/auth/callback`을 Redirect URL로 추가합니다. `allowed_users` 표에 초대할 이메일을 소문자로 등록하고, 첫 관리자는 `role = 'admin'`으로 설정합니다.
3. Vercel에서 이 GitHub 저장소의 `main` 브랜치를 Import하고, `.env.example`의 Supabase·나라장터·사이트 URL·Cron 값을 **Production과 Preview 환경에만** 등록합니다. `SUPABASE_SERVICE_ROLE_KEY`, `NARAJANGTEO_SERVICE_KEY`, `CRON_SECRET`은 절대로 `NEXT_PUBLIC_` 접두사를 붙이지 않고 Git에 저장하지 않습니다.
4. Vercel Cron은 [vercel.json](./vercel.json)의 `0 23 * * *`에 따라 UTC 23:00(한국 08:00)에 실행을 요청합니다. Hobby Cron은 시간 단위 정확도만 보장하므로 08:00~09:00 내 완료를 목표로 합니다.

현재 첨부 분석은 공고당 최대 3개, 파일당 10MB의 PDF/HWPX 범위로 제한합니다. HWP·ZIP·스캔 PDF·대용량 파일은 보류 또는 실패 사유로 남기며, 이메일과 AI 분석은 아직 발송하지 않습니다. Supabase Storage의 `bid-documents` 버킷은 비공개입니다. API 키는 관리자 화면이 아니라 Vercel 환경변수에만 등록합니다.

## 운영 전환 체크리스트

1. 공공데이터포털에서 나라장터 입찰공고정보서비스 인증키를 발급받고, 최신 OpenAPI 응답 필드를 검증합니다.
2. 나라장터 API 응답에 포함되는 첨부 URL 필드를 실제 승인받은 API 응답으로 검증합니다.
3. 스캔 PDF OCR과 구형 HWP 추출은 별도 워커로 분리합니다.
4. 이용량이 늘면 Vercel Hobby의 비상업적 사용·Cron 시간 오차·함수 한도를 검토하고 유료 또는 워커 구조로 전환합니다.

> 이 서비스의 점수와 자격 상태는 검토 보조 정보입니다. 실제 입찰 참가 전에는 나라장터 원문 공고 및 첨부문서를 반드시 확인해야 합니다.
