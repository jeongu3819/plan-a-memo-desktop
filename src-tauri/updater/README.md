# 업데이트 서명 공개키

채널마다 **다른 키쌍**을 쓴다. 이 폴더에는 공개키(`<채널>.pub`)만 커밋한다.

| 파일 | 내용 | 커밋 |
|---|---|---|
| `production.pub` | 운영 채널 공개키(`tauri signer generate` 의 `.pub` 내용) | ✅ |
| `staging.pub` | staging 채널 공개키 | ✅ |
| 개인키(`*.key`) | 서명용 — **저장소·EXE·공유 폴더에 두지 않는다** | ❌ (.gitignore) |

채널별로 키가 다르면 staging 서명 파일은 운영 앱의 서명 검증을 통과하지 못한다(엔드포인트·latest.json 의 `channel` 검사와 함께 이중 방어).

만들기·보관·교체 절차: [docs/release.md](../../docs/release.md#2-서명키)
