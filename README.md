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
| `GEMINI_MODEL` | 선택값. 기본값은 `gemini-3.1-flash-lite` |

`SUPABASE_SERVICE_ROLE_KEY`와 `NARAJANGTEO_SERVICE_KEY`에는 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다. 값 변경은 새 배포부터 적용됩니다.

## Supabase 초기화

1. Supabase SQL Editor에서 `supabase/migrations/202608250001_initial_schema.sql`, `202608250002_admin_only_writes.sql`, `202608250003_public_read_admin_settings.sql`, `202608260001_notice_ai_jobs.sql`, `202608280001_batch_window.sql`을 순서대로 실행합니다.
2. 원본 첨부파일은 Storage에 저장하지 않습니다. `bid-documents` 버킷은 이전 설치에서 남아 있어도 사용하지 않습니다.
3. 배포 후 `/admin`에 접속해 관리자 코드를 입력합니다.
4. 초기 설정 진단에서 모든 항목이 준비됨으로 표시되면 주제·키워드·점수 기준을 저장합니다.

## 배치

정기 배치는 GitHub Actions의 `.github/workflows/daily-batch.yml`이 `15 23 * * *`(UTC), 한국 시간 오전 8시 15분에 실행하도록 구성합니다. 정각 집중 지연을 피하면서 8~9시 범위 안에서 실행하며, Actions가 Vercel 함수 시간 제한 없이 전체 작업을 끝까지 수행합니다. GitHub 스케줄 이벤트가 생성되지 않는 운영 공백에 대비해 Vercel Cron도 `20 23 * * *`(UTC)에 백업 실행하며, Supabase 배치 잠금으로 중복 실행을 차단합니다. `workflow_dispatch` 또는 관리자 화면에서 실패한 배치를 수동 재시도할 수 있습니다. 운영 화면에는 실제로 저장된 실행 시각과 분석 구간이 표시됩니다.

배치는 실행시각 기준 최근 24시간의 용역 공고만 조회합니다. `입찰공고번호 + 공고차수`로 중복을 제거합니다. 첨부파일별 큐 작업에서 PDF·HWP·HWPX의 텍스트만 추출합니다. 모든 첨부 작업이 끝나면 공고당 한 번 Gemini에 정제 텍스트를 전송합니다. 성공하면 원본 파일은 저장하지 않고, Supabase의 임시 추출 텍스트도 즉시 삭제하며 점수·요약·AI 생성 근거만 남깁니다.

### GitHub Actions 설정

저장소 `Settings → Secrets and variables → Actions`에 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NARAJANGTEO_SERVICE_KEY`, `GEMINI_API_KEY`를 Secrets로 등록합니다. 필요하면 Variables에 `GEMINI_MODEL`을 등록하며 기본값은 `gemini-3.5-flash-lite`입니다. 첫 실행은 Actions 탭의 `Run workflow`로 검증하고 이후 매일 자동 실행됩니다.

스캔 PDF·이미지·표·도면은 분석 범위에 포함하지 않습니다. 첨부파일이 있는 공고는 모든 첨부 텍스트가 준비되고 Gemini 분석이 성공할 때만 점수를 표시합니다. 첨부파일이 없는 공고만 Gemini의 공고명·설명 분석을 사용합니다. Gemini Free Tier의 실제 할당량 거절(HTTP 429·`RESOURCE_EXHAUSTED`)은 `notice_ai_jobs.failure_reason`에 별도 기록되며, 규칙 기반 점수로 대체하지 않습니다.

## 개발 검증

```powershell
pnpm install
pnpm test
pnpm build
```

로컬 개발은 실제 Supabase와 나라장터 환경변수가 필요하며, 로컬 목업 데이터 모드는 운영 경로에 포함하지 않습니다.

> 적합도와 참가조건은 검토 보조 정보입니다. 실제 입찰 전에는 나라장터 원문 공고와 첨부문서를 반드시 확인해야 합니다.
