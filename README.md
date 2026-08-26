# BidFit

나라장터 입찰공고를 공개 열람하고, 관리자가 지정한 주제와 첨부문서 텍스트 기반 적합도를 확인하는 Vercel 공개 베타입니다.

## 운영 구조

- 일반 사용자는 로그인 없이 공고·점수·첨부 처리 상태를 열람합니다.
- 관리자는 `/admin`에서 관리자 코드를 입력한 뒤 탐색 주제와 운영 상태를 관리합니다.
- Supabase·나라장터·Cron 비밀값은 관리자 화면이나 Git에 저장하지 않고 Vercel 서버 환경변수로만 관리합니다.
- 필수 설정이 빠진 배포본은 공개 화면 대신 관리자 설정 진단 화면으로 이동합니다.
- 공고 적합도는 `GEMINI_API_KEY`가 설정된 경우에만 공고당 한 번 Gemini 텍스트 분석으로 산정합니다. 키가 없을 때 키워드 기반 점수로 대체하지 않으며, 분석 결과도 생성하지 않습니다.

## Vercel 설정

Vercel 프로젝트의 `Settings → Environment Variables`에서 `Production` 환경에 다음 값을 등록한 뒤 반드시 새 배포를 실행합니다.

| 변수 | 용도 |
|---|---|
| `ADMIN_ACCESS_CODE` | 관리자 페이지 접근 코드 |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 DB·Storage 접근 키 |
| `NARAJANGTEO_SERVICE_KEY` | 나라장터 OpenAPI 인증키 |
| `CRON_SECRET` | Vercel Cron 호출 검증값 |
| `GEMINI_API_KEY` | Gemini 텍스트 분석 API 키 |
| `GEMINI_MODEL` | 선택값. 기본값은 `gemini-2.5-flash-lite` |

`SUPABASE_SERVICE_ROLE_KEY`와 `NARAJANGTEO_SERVICE_KEY`에는 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다. 값 변경은 새 배포부터 적용됩니다.

## Supabase 초기화

1. Supabase SQL Editor에서 `supabase/migrations/202608250001_initial_schema.sql`, `202608250002_admin_only_writes.sql`, `202608250003_public_read_admin_settings.sql`, `202608260001_notice_ai_jobs.sql`을 순서대로 실행합니다.
2. 원본 첨부파일은 Storage에 저장하지 않습니다. `bid-documents` 버킷은 이전 설치에서 남아 있어도 사용하지 않습니다.
3. 배포 후 `/admin`에 접속해 관리자 코드를 입력합니다.
4. 초기 설정 진단에서 모든 항목이 준비됨으로 표시되면 주제·키워드·점수 기준을 저장합니다.

## 배치

`vercel.json`의 Cron은 `0 23 * * *`(UTC)이며 한국 시간 오전 8시 전후 실행을 목표로 합니다. Vercel Hobby Cron은 정확한 분 단위 실행을 보장하지 않습니다. 관리자 운영 화면에서는 같은 배치를 수동 실행할 수 있습니다.

배치는 최근 72시간 공고를 물품·용역·공사·외자 유형으로 조회하고, `입찰공고번호 + 공고차수`로 중복을 제거합니다. 첨부파일별 큐 작업에서 PDF·HWP·HWPX의 텍스트만 추출합니다. 모든 첨부 작업이 끝나면 공고당 한 번 Gemini에 정제 텍스트를 전송합니다. 성공하면 원본 파일은 저장하지 않고, Supabase의 임시 추출 텍스트도 즉시 삭제하며 점수·요약·AI 생성 근거만 남깁니다.

스캔 PDF·이미지·표·도면은 분석 범위에 포함하지 않습니다. 텍스트를 추출하지 못한 파일은 분석 제외 사유만 기록합니다. Gemini Free Tier는 요청·토큰 한도가 변동될 수 있으므로, 배포 전에 Google AI Studio의 프로젝트별 Rate limit을 확인해야 합니다.

## 개발 검증

```powershell
pnpm install
pnpm test
pnpm build
```

로컬 개발은 실제 Supabase와 나라장터 환경변수가 필요하며, 로컬 목업 데이터 모드는 운영 경로에 포함하지 않습니다.

> 적합도와 참가조건은 검토 보조 정보입니다. 실제 입찰 전에는 나라장터 원문 공고와 첨부문서를 반드시 확인해야 합니다.
