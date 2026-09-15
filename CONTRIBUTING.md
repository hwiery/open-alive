# Contributing to open-alive / 기여 가이드

Thanks for your interest! / 관심 가져주셔서 감사합니다!

## Ground rules / 기본 규칙

- Be kind — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). / 행동 강령을 지켜주세요.
- Security issues go to private reporting, **not** public issues — see [SECURITY.md](SECURITY.md). / 보안 이슈는 비공개로 제보해주세요.
- Never commit secrets, tokens, `.env` files, or personal data (session transcripts, local paths). / 시크릿·토큰·`.env`·개인 데이터는 커밋하지 마세요.

## Development setup / 개발 환경

Requirements / 필요 도구: Node.js ≥ 20 (LTS 20/22/24 recommended / LTS 권장), pnpm ≥ 10, git. Python 3 is optional (Efficio).

```bash
git clone <your-fork-url> open-alive
cd open-alive
pnpm install
pnpm build
pnpm test
```

Run from source without touching your real Claude Code settings / 실제 설정을 건드리지 않고 실행:

```bash
# Use a throwaway HOME so hooks and data go to a temp dir
# 임시 HOME을 써서 훅·데이터를 임시 폴더에 둡니다
HOME=$(mktemp -d) OPEN_ALIVE_PORT=3999 node packages/server/dist/index.js
```

UI hot reload / UI 핫 리로드: `pnpm --filter=@open-alive/ui dev` (Vite on :5173, proxies to :3141).

## Before opening a PR / PR 전에

```bash
pnpm build
pnpm test
pnpm --filter=@open-alive/ui exec tsc --noEmit
```

- Keep changes focused; one topic per PR. / PR 하나에 주제 하나.
- Add or update tests for behaviour changes. / 동작 변경에는 테스트를 추가·수정해주세요.
- All UI strings go through i18n (`packages/i18n/src/locales/{en,ko}.json`). / UI 문자열은 i18n 키를 사용합니다.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:` …). / 커밋 메시지는 Conventional Commits 형식.

## Project layout / 구조

See the "Architecture" section of [README.md](README.md) and [CLAUDE.md](CLAUDE.md).

## License / 라이선스

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
기여하신 코드는 MIT 라이선스로 배포되는 것에 동의하는 것으로 간주합니다.
