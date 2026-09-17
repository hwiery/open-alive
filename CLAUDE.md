# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

open-alive: Claude Code 세션 실시간 대시보드 + 티켓 러너 (오픈소스, MIT). 훅 이벤트를 WebSocket 으로 UI 에 스트리밍하고, 티켓을 Claude Code CLI 로 실행·검증한다.

## 기술 스택

- **Monorepo**: pnpm 10 + Turborepo (Node ≥ 20)
- **프론트엔드**: React 19, Vite 6, Tailwind CSS 4, TypeScript 5.7
- **서버**: Node.js + ws (WebSocket), Zod, better-sqlite3, node-pty (port 3141)
- **테스트**: vitest 4 (루트 `vitest.config.ts` 가 패키지별 project 를 묶음)
- **i18n**: i18next (EN/KO), 모든 UI 텍스트 번역 필수
- **배포**: npm 패키지 (`scripts/build-npm.sh` 가 esbuild 로 `npm-dist/` 단일 번들 생성)

## 빌드 & 실행

```bash
pnpm install
pnpm build                                        # 전체 빌드 (turbo, ^build 의존)
pnpm test                                         # turbo test — 각 패키지 build 후 vitest run
pnpm --filter=@open-alive/ui exec tsc --noEmit    # UI 타입 체크 (CI 에서도 실행)
pnpm --filter=@open-alive/server test             # 패키지 하나만 테스트
pnpm --filter=@open-alive/server exec vitest run src/__tests__/ticketRunner.test.ts   # 단일 파일
pnpm --filter=@open-alive/server exec vitest run -t "테스트 이름"                      # 단일 케이스
```

- 패키지 간 import 는 `dist/` 를 참조한다. core/storage 등을 고친 뒤 의존 패키지를 테스트하려면 먼저 `pnpm build`.
- CI(`.github/workflows/ci.yml`): ubuntu/macos × Node 20/22/24 에서 install --frozen-lockfile → build → UI tsc → test, 별도로 `pnpm audit`. `hwiery/open-alive` 에서만 실행(포크·미러는 `if: github.repository` 조건으로 건너뜀) — 다른 저장소의 러너 자원을 쓰지 않는다.
- server 테스트는 `OA_DELEGATE_MODELS_FILE=builtin` 으로 고정 — 로컬 `~/.open-alive/models.json` 이 테스트에 영향을 주지 않게 한다.

실제 `~/.claude/settings.json`·데이터를 건드리지 않고 소스에서 실행:

```bash
HOME=$(mktemp -d) OPEN_ALIVE_PORT=3999 node packages/server/dist/index.js
pnpm --filter=@open-alive/ui dev    # Vite :5173, /api·/ws 를 :3141 로 프록시
```

## 패키지 구조

```
packages/
├── core/        # 공유 타입, AgentFSM, SessionStore, WS 프로토콜, transcript 파서, 티켓 타입, env 로더
├── server/      # HTTP + WebSocket 서버, 티켓 러너·검증기, 오케스트레이터(LiteLLM 위임), 패널, PTY
├── storage/     # SQLite 이벤트 로그 + 재생성 가능한 projection
├── hooks/       # 훅 설치기 + scripts/stream-event.sh (17개 이벤트 등록)
├── cli/         # open-alive CLI (setup/install/start/stop/status/doctor/token/autostart)
├── i18n/        # i18next 설정 + EN/KO 번역 파일
├── prompt-*/    # 프롬프트 수집·규칙·분석 (서버 프로세스 안에서 동작, tsup 빌드)
└── ui/          # React 프론트엔드 (Vite)
efficio/         # 세션 자기평가 (Python stdlib, 세션 종료 시 python3 로 실행)
docs/adr/        # 아키텍처 결정 기록 (한국어) — 설계 변경 전 해당 ADR 확인
npm/             # npm 번들 엔트리 (server-entry.ts)
```

## 아키텍처

### 데이터 흐름
```
Claude Code Hook → ~/.open-alive/hooks/stream-event.sh → HTTP POST /api/event → Server → WebSocket /ws → UI (React)
```

- 훅 스크립트는 2초 타임아웃, 항상 exit 0 — Claude Code 를 절대 막지 않아야 한다.
- 서버는 기본 `127.0.0.1` 바인드. 원격 모드는 디바이스 토큰으로만 허용 (ADR 0009, 0013; `wsAuth.ts`, `wsOrigin.ts`, `remoteAccess.ts`).
- 서버 조립은 `packages/server/src/index.ts` 한 곳에서 이루어진다 (스토어·러너·검증기·패널·WS 브로드캐스터 wiring).
- 서버 상태는 `~/.open-alive/` 아래 JSON 파일(tickets.json, runs.json, agent-names.json 등) + SQLite 로 저장된다.

### 에이전트 상태 머신
```
spawning → listening → active → idle
                ↓         ↓
             waiting    error → active
                ↓
              done → despawning → removed
```

### 티켓 파이프라인 (server)
- `ticketRunner.ts` — 지정 cwd 에서 headless Claude 실행 (cwd 는 허용 루트 검사, 로컬/SSH executor 선택: `executors/`).
- `ticketVerifier.ts` — 별도 headless Claude 가 목표 충족을 JSON verdict 로 판정. **fail-closed**: 파싱 불가 verdict 는 done 이 아니라 failed.
- `panel/` — LiteLLM 게이트웨이 모델 여러 개로 검증·결정 패널 (`LITELLM_KEY` 없으면 비활성).
- `orchestrator/` — `oa-delegate` CLI 로 서브태스크를 게이트웨이 모델에 위임, 모델 목록은 `models.json`.
- `ticketCommit.ts` — 검증 통과 시 티켓 repo 에 자동 커밋 (`OPEN_ALIVE_AUTO_COMMIT`).

### UI
- 뷰는 `packages/ui/src/views/*` (unified, dashboard, pixel, tickets, board, workspace …), 모바일은 `src/mobile/` 별도 앱.
- unified 뷰: 왼쪽 `ProjectSidebar`, 중앙 PixelCanvas, 오른쪽 `RightPanel` (ActivityPulse + CompletionLog + EventStream), 상단 `HeaderBar`.
- 단일 WebSocket 연결(`useWebSocket`)로 React 상태를 피드.

### 디자인 시스템
- **폰트**: UI 텍스트 `Pretendard / system-ui` (--font-ui), 코드/시간 `SF Mono` (--font-mono)
- **컬러 토큰**: `packages/ui/src/index.css` 의 CSS 변수 (다크 기본 + 라이트 테마 재정의). 색은 하드코딩하지 말고 토큰 사용
- **라운딩**: 카드/패널 `rounded-xl` (12px), 버튼 8~10px, 에이전트 카드 `rounded-2xl`
- **여백 기준**: 패딩 20~24px, 카드 간 gap 4~8px
- **hover**: `background-color` 변화 + 미세 `translateY(-1px)`
- **스크롤바**: 6px 얇은 커스텀 스크롤바

### 주요 데이터 타입 (core 패키지)
- `AgentInfo` — sessionId, state, parentId (서브에이전트 판별), displayName, cwd, currentTool
- `AgentState` — spawning | idle | listening | active | waiting | error | done | despawning | removed
- `WSServerMessage` — snapshot / agent:spawn / agent:despawn / agent:state / agent:prompt / event:new
- `HookEventName` — 17개 훅 이벤트 (SessionStart, PreToolUse, SubagentStart 등)

### i18n 규칙
- 모든 UI 텍스트는 `packages/i18n/src/locales/{en,ko}.json` 번역 키 사용 필수 (두 파일 동시 갱신)
- React 컴포넌트: `useTranslation()` 훅 → `t('key')`
- 비-React 코드 (canvas, class component): `import i18n from '@open-alive/i18n'` → `i18n.t('key')`
- 하드코딩된 문자열 금지 (fallback 포함)

## 사용자 설정 원칙

- 모든 개인·환경별 값(게이트웨이 URL/키, 모델 목록, 포트)은 코드에 하드코딩하지 않는다. `~/.open-alive/.env`, `~/.open-alive/models.json` 으로만 받는다. 프로세스 env 가 파일보다 우선.
- 새 설정을 추가하면 `.env.example`, README 설정 표, 필요 시 `open-alive setup` 을 함께 갱신한다.
- 테스트 픽스처에 실제 사용자 경로·프로젝트명·사내 도메인을 쓰지 않는다.

## 커밋 & 릴리즈

- 커밋 메시지는 Conventional Commits (`feat:`, `fix:`, `docs:` …).
- 루트 `package.json` 버전이 단일 진실 소스. `pnpm release:patch|minor|major` → 버전 bump, changelog 재생성, `npm-dist/` 빌드, 태그, publish.
