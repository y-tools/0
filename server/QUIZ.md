# みんなで漢字

Independent Python/SQLite service. Does not import or share credentials, cookies, data, ports, or runtime dependencies with bingo or Y-OBS.

## Screens

- `/quiz/`: listener, 16:9 board, no login required.
- `/quiz/?view=player`: participant login and latest-answer submission.
- `/quiz/?view=host`: game master login and controls.
- `/quiz/?view=screen`: board-only window. The 別ウィンドウで表示 button opens this view. It fits a 16:9 board inside any window size with black margins as needed; no control panels or submission forms are rendered visibly.

Owner ID: `Y`. The initial password is provisioned directly into the private database as a salted scrypt hash; no password is included in this repository. Sessions last at most 12 hours. Delegated game masters expire after the configured 1–168 hours and can be revoked by the owner. Delegates can manage questions, images, accounts and the game, but cannot create/revoke delegates.

## Operation

Question creation/editing and listener question submissions include an optional free-text ジャンル field (up to 40 characters, with suggestions). Genres carry through moderation, can be edited by the host before adoption, and appear in the host question list and active shared board label. Blank values display as 未分類 in host lists. Bank-added questions default to 漢字の読み. The additive question_genres/submission_genres tables preserve older layouts and original insert compatibility; older clients that omit a genre retain an existing question's genre. Existing bank-linked questions are backfilled once without replacing an explicit genre value.

1. Configure up to four participants and optional avatars. Images are cropped to square 256×256. Blank passwords on new accounts are generated and shown once; on existing accounts blank preserves the current password. Changing ID/password or disabling a slot revokes that participant's sessions and removes their previous answers.
2. Upload screen images (PNG/JPEG/WebP, under 6MB each; 400 total). Server validates and re-encodes them; screen images fit within 1920×1080. Register questions with a correct answer, a timer (1–3600 seconds) and optionally multiple images. Up to 200 questions.
3. Select 出題 in the question list. This publishes the question and waits for スタート. Starting opens answers until the server-controlled deadline. Repeated submissions overwrite the same player's answer in the same round.
4. The deadline closes answers and displays TIME UP. 正解を表示 publishes the correct answer and the four latest answers in a 2×2 grid. Correct answers have red panels; incorrect or missing answers have gray panels. Matching uses Unicode NFKC normalization and trims leading/trailing whitespace, then compares exactly. Before reveal, no correctness verdict is sent to players or listeners. Only the game master can see every answer; a player can see their own. Future questions and correct answers are excluded from public state.
5. Click a screen image, 問題画面, 正解を表示, or 待機画面 to switch the shared display. Image switches preserve an active timer. A new 出題 creates a fresh round. 待機画面 closes any running timer.

## Graded kanji reading bank

The separate SQLite bank contains 12,000 unique written words: 2,000 each for 5/4/3/2/pre-1/1. In 級別の問題データベース choose a level, 1–20 questions and a duration, then ランダム抽出して確認. Check the word/reading preview and add the selection to the active question list. Nothing is presented automatically. Previously added or excluded records are not sampled again. The active game queue retains its 200-question limit; the 12,000-record bank is stored separately and is not included in each public/host state payload.

Bank questions display the word prominently and accept hiragana or equivalent katakana readings. Existing non-bank questions keep their existing answer comparison rules. Correct readings are withheld from public state until reveal. The bank endpoint requires owner/GM authentication. Batch additions are atomic, and duplicate additions are rejected.

Deploy `server/kanji_bank/` with its manifest, source credits and rebuild tools. Run `quiz_server.py import-bank` as the quiz account with the existing QUIZ_DATA before restarting the service. All six 2,000-record counts and hashes are checked before the import transaction; repeated imports preserve exclusions and history. New releases have distinct version IDs. See `kanji_bank/SOURCES.md` for source licences, verification scope and limitations, and `kanji_bank/tools/README.md` for periodic dictionary refresh/rebuild steps.

## Listener submission operation

Both receptions default to closed. In リスナー投稿の受付 the game master can enable question submissions, set a **global total** cap of 1–200 questions for the current reception, and choose hints: off / private only / global only / both. The cap includes pending, approved and rejected posts; reaching it closes public reception automatically. 件数をリセットして問題受付を開始 creates a fresh reception count while retaining pending posts for review. Changing the cap alone does not reset it. Concurrent submissions are serialized by SQLite so the cap cannot be exceeded.

Listener forms require no login. Questions include a title, prompt, correct answer and duration. They remain private to game masters until a host chooses 確認・編集して採用, edits/saves the question, and then separately clicks 出題 in the question list. Saving an adopted post never auto-presents it. 不採用 dismisses a pending post. Neither the submission queue nor submitted correct answers are returned by public APIs.

Hints refer to the current question round. A listener can select an enabled player for a private hint, or the shared game board for a global hint, according to the reception setting. A game master previews/edits the hint and explicitly publishes it. Only one hint per destination is visible at a time; 非表示にする hides it and approved hints can be shown again. Private hints are returned only to that authenticated player and are displayed in their answering panel, never in the shared board or popup. Global hints appear on every shared game board. A new round or 待機画面 clears displayed hints; stale-round posts cannot be published. Player identity is checked again before publishing, preventing a replaced player from receiving a previous player's hint.

The server limits pending posts to 500, hint posts to 200 per round, and anonymous submissions to 30/minute per IP. Reviewed history is bounded while preserving the current reception count. Additive SQLite tables are created on startup, preserving existing accounts, questions, images, sessions and active game state.

Run `python server/test_quiz.py` in a disposable local environment (Pillow required) for the game and submission integration checks. `--serve` keeps its local fixture running on port 18793 for browser checks. Never run test fixtures against production state.

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
