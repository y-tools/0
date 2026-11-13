# みんなでクイズ

Independent Python/SQLite service. Does not import or share credentials, cookies, data, ports, or runtime dependencies with bingo or Y-OBS.

## Screens

- `/quiz/`: listener, 16:9 board, no login required.
- `/quiz/?view=player`: participant login and latest-answer submission.
- `/quiz/?view=host`: game master login and controls.

Owner ID: `Y`. The initial password is provisioned directly into the private database as a salted scrypt hash; no password is included in this repository. Sessions last at most 12 hours. Delegated game masters expire after the configured 1–168 hours and can be revoked by the owner. Delegates can manage questions, images, accounts and the game, but cannot create/revoke delegates.

## Operation

1. Configure up to four participants and optional avatars. Images are cropped to square 256×256. Blank passwords on new accounts are generated and shown once; on existing accounts blank preserves the current password. Changing ID/password or disabling a slot revokes that participant's sessions and removes their previous answers.
2. Upload screen images (PNG/JPEG/WebP, under 6MB each; 400 total). Server validates and re-encodes them; screen images fit within 1920×1080. Register questions with a correct answer, a timer (1–3600 seconds) and optionally multiple images. Up to 200 questions.
3. Select 出題 in the question list. This publishes the question and waits for スタート. Starting opens answers until the server-controlled deadline. Repeated submissions overwrite the same player's answer in the same round.
4. The deadline closes answers and displays TIME UP. 正解を表示 publishes the correct answer and the four latest answers. Before that, only the game master can see every answer; a player can see their own. Future questions and correct answers are excluded from public state.
5. Click a screen image, 問題画面, 正解を表示, or 待機画面 to switch the shared display. Image switches preserve an active timer. A new 出題 creates a fresh round. 待機画面 closes any running timer.

## Deployment

Service: `yplus-quiz.service`, loopback port `8793`. Code `/opt/yplus-quiz`, separate venv using `quiz-requirements.txt`, private state `/var/lib/yplus-quiz`. Use a dedicated `yplus-quiz` service account. Install the supplied systemd unit after creating the data directory and initializing the owner.

`quiz_server.py init-owner-hash` reads JSON `{ "id": "Y", "hash": "scrypt:<16-byte salt hex>:<64-byte digest hex>" }` from standard input. Compute the hash with `hash_password()` privately. Existing owners are preserved. Never put passwords, initialization records or database files in GitHub.

Main Caddy host needs these handlers before its default catch-all:

```caddy
handle /quiz {
    redir /quiz/ 302
}
handle /quiz/* {
    reverse_proxy 127.0.0.1:8793 {
        header_up X-Real-IP {remote_host}
    }
}
```

Validate Caddy before reload. Preserve every existing handler. Health: `/quiz/api/health`. HTTPS required for the secure HttpOnly session cookie. APIs use no-store; static assets use revalidation plus versioned references. Uploaded images use immutable random URLs. GitHub Pages' `/quiz/` redirects to the VPS origin so login and APIs remain same-origin.

For local testing only, override `QUIZ_DATA`, `QUIZ_STATIC`, `QUIZ_PORT`, `QUIZ_ORIGIN`, and `QUIZ_SECURE_COOKIE=0`. Use disposable test accounts. Back up the SQLite database with SQLite's online backup API and copy its media directory; do not copy a live SQLite file without WAL handling.
