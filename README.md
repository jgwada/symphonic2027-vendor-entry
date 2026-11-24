# Symphonic Starmine 2027 飲食出店 応募フォーム（LINE版）

仕様は `SPEC.md`。下敷きは合唱の応募フォーム。

## ファイル
- `index.html` … 画面（LIFF）。1枚。質問の定義は中の `<script type="application/json" id="schema">`
- `gas/Code.gs`, `gas/appsscript.json` … 保存側（Apps Script ウェブアプリ）。質問の定義 `FIELDS` は index.html の schema と同じ内容
- `test/run.mjs` … `node test/run.mjs`（にせ物の Google・LINE で動く。本物にはつながない）

## 設定値
index.html の上の方: `LIFF_ID`（空だと「設定が終わっていません」）/ `API_URL`（ウェブアプリのURL）/ `ADD_FRIEND_URL`
Code.gs のいちばん上: `DEADLINE` / `DEADLINE_TEXT` / `RESULT_DATE_TEXT`（画面の日付はここから status で返す）
スクリプトプロパティ:
| キー | 内容 |
|---|---|
| `PARENT_FOLDER_ID` | 共有ドライブ「11_飲食出店者」`1cYw5UcJXJTCAxC9Z7w-nBBri3q_1eUJ3` |
| `LINE_LOGIN_CHANNEL_ID` | LINEログインチャネルID（IDトークンの確認に使う） |
| `ENTRY_FORM_URL` | `https://liff.line.me/<LIFF_ID>` |
| `LINE_CHANNEL_TOKEN` | 公式LINEの鍵。シートのメニュー「飲食出店フォーム」→「公式LINEの鍵を設定」から入れる |
| `TEST_SECRET` | 試験用。本番では空のまま（空なら抜け道なし） |
自動で入るもの: `ROOT_FOLDER_ID` `TEMP_FOLDER_ID` `SHEET_ID` `SEQ` `applied:<sub>` `folder:<受付番号>` `LINE_LAST_RESULT`

## 立ち上げ手順（親がやる）
0. 前提：デプロイする人は共有ドライブ「11_飲食出店者」でコンテンツ管理者以上。LINEログインチャネルと Messaging API チャネルは同じプロバイダー（Symphonic）に置く（違うとフォームで取ったユーザーIDに公式LINEから送れない）
1. Apps Script に Code.gs・appsscript.json を置く（Drive v3 の拡張サービスが有効になる）
2. スクリプトプロパティに上の値を入れる
3. `setup()` を1回実行（フォルダ「飲食出店 応募フォームの回答」＋「一時保管」＋シートができる。何度実行しても増えない）
4. `installTriggers()` を実行（毎日3時の `cleanupTemp`、シートを開いたときのメニュー）
5. `checkLine()` を実行して外部接続を許可（許可画面のチェックは外さない）
6. ウェブアプリとしてデプロイ（実行: 自分 / アクセス: 全員）→ URL を `API_URL` に。直したあとは「新しいバージョン」でデプロイ（URLを変えない）
7. LIFF のエンドポイントURLを GitHub Pages のURLに。リッチメニューは `https://liff.line.me/<LIFF_ID>`

## 運用
- `resetApplied('<LINEのsub>')` … 応募済みの印を消す（行を消しただけでは印は残る）
- 運営が足した列（選考結果など）は上書きされない。見出しの名前で列を探す
- 後から項目を足すときは `FIELDS` と index.html の schema の両方に足し、試験を通す。シート見出しは右端に自動で足される
- 手元確認: `python3 -m http.server` → `http://localhost:8000/index.html?mock=1&state=new|applied|closed|closedApplied|notFriend|error`（localhost / 127.0.0.1 だけ有効）

## リッチメニュー「応募フォーム」→ 名乗り（LINE の Webhook）
リッチメニューの「応募フォーム」を押すと、トークに「応募フォーム」と送られる。doPost が LINE の Webhook として受け取る（本文に `events` 配列があるものだけ。既存の action API とは分けてあり、常に 200 で `{}` を返す）。
- 名乗っていない・応募済みでもない人 → 「店舗名と代表者名を送ってください。」、状態 `greet:<userId>` = `waiting`
- 名乗り待ちの人から次のテキスト（「応募フォーム」以外）→ タブ「名乗り」に1行（日時・LINEユーザーID・LINE表示名・送られた文。2,000字で切る）、状態 `done`、「ありがとうございます。下記のリンクから応募フォームにお進みください。」＋ `ENTRY_FORM_URL`
- 名乗り済み・応募済み（`applied:<userId>`）の人が「応募フォーム」→ 「下記のリンクから応募フォームにお進みください。」＋ `ENTRY_FORM_URL`
- それ以外（普通の文・スタンプ・画像・follow など）は何もしない（運営が手動チャットで返す）
- 「応募フォーム」の判定は前後の空白を除いた完全一致
なりすまし対策（Apps Script では X-Line-Signature が読めないため）: `destination` が `BOT_USER_ID` と一致しなければ無視（空なら bot/info から取って保存）／状態を変える前に `GET /v2/bot/profile/<userId>` が 200 であること（displayName を表示名に使う）／同じ `webhookEventId` は6時間キャッシュして1回しか処理しない。
設定: LINE Developers の Messaging API チャネルで Webhook URL にウェブアプリのURLを入れ、「Webhookの利用」をオン。応答メッセージ（自動応答）は、運営が手動チャットで返す運用なので状況に合わせて設定する。返信の結果は `LINE_LAST_REPLY`（日時・状態コード）。「名乗り」タブは `setup()` が作る（無ければ最初の名乗りで作る）。
