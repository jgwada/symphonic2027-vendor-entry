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
