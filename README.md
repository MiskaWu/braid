# braid

Claude 的多帳號工具。每個帳號是一股線，你的工作是編成的那一條辮子：
換帳號時把一股接進另一股（**遷移**），用量用完換另一股承重（**用量切換**），
幾個帳號長期並用就把它們編在一起（**同步**）。

| 用法 | 給誰 | 狀態 |
|---|---|---|
| 遷移 | 換帳號，搬一次就好 | **可用**（下面說明） |
| 用量切換 | 一個帳號用量用完，換另一個繼續同一個對話 | 規劃中（CLI 與 Linux 也支援） |
| 同步 | 幾個帳號長期並用，工作保持一致，可選資料夾範圍 | 規劃中 |

Claude 桌面 app 換帳號登入後，Code 分頁側欄的舊對話和「已儲存的環境」都不見了。
資料其實還在電腦上，只是桌面 app 依帳號分開存。這個工具把它們複製到目前登入的帳號。

## 會搬什麼

| 項目 | 處理 |
|---|---|
| Code 分頁側欄的 session | **搬**：複製到新帳號，點進去就能接著做（對話紀錄本來就在電腦上） |
| 封存狀態 | **搬**：舊帳號封存的，新帳號也是封存 |
| 已儲存的環境 | **搬**：連同各資料夾預設的模型與 effort、最近使用的位置；新帳號已有同一個資料夾的環境就保留新帳號那筆 |
| Claude Code 的記憶、`CLAUDE.md`、設定、hooks | **不用搬**：都在 `~/.claude`，依專案資料夾分，不分帳號 |
| claude.ai 的聊天、Projects、artifacts、claude.ai 記憶 | **搬不了**：存在伺服器、綁帳號 |
| Cowork 的對話與記憶、從 CLI 開的 session | 這一版還沒處理 |

## 使用前

1. **先用新帳號登入桌面 app，在 Code 分頁開一個新對話**（打一句話就好）。工具靠這個認得新帳號。
2. **一台電腦只用一個 `~/.claude`**：不要照官方的多帳號建議替每個帳號設 `CLAUDE_CONFIG_DIR`，
   那樣記憶、對話紀錄、設定會被按帳號拆開。

## 安裝

三種方式擇一，都不用改任何設定檔。

**A. 請 Claude 幫你裝**：在任何一個 Claude Code 對話（桌面 app 的 Code 分頁也可以）輸入：

> 請照 https://github.com/MiskaWu/braid README 的「給 Claude 的安裝步驟」幫我安裝

**B. 自己在終端機裝**（電腦上有 `claude` 指令的話）：

```bash
claude plugin marketplace add MiskaWu/braid && claude plugin install braid@braid
```

**C. 不裝，直接雙擊**（不需要 Claude Code）：下載這個 repo，Windows 雙擊 `mod/tool/windows/migrate.cmd`，
macOS 雙擊 `mod/tool/macos/migrate.command`（從瀏覽器下載的話，第一次要按右鍵 →「打開」）。

### 給 Claude 的安裝步驟

照下面做，不要改 `settings.json`，也不要替使用者執行遷移（遷移由使用者自己打指令）。

1. 決定用哪個 `claude`：`command -v claude` 有結果就用它；沒有的話用環境變數 `$CLAUDE_CODE_EXECPATH`
   （目前這個 Claude Code 本身，桌面 app 的 Code 分頁裡也有）。以下記作 `$CLAUDE`。
2. 加入 marketplace：`"$CLAUDE" plugin marketplace add MiskaWu/braid`。
   已經加過的話改跑 `"$CLAUDE" plugin marketplace update braid`。
3. 安裝：`"$CLAUDE" plugin install braid@braid`。已經裝過的話改跑 `"$CLAUDE" plugin update braid@braid`。
4. 用 `"$CLAUDE" plugin list` 確認 `braid@braid` 是 enabled，然後告訴使用者：先輸入 `/reload-plugins`
   （或開一個新對話），再輸入 `/braid migrate 試跑` 看會搬什麼。

## 使用

- `/braid migrate 試跑`：另外開一個視窗**只列計畫、不寫入**。Claude 不用結束，先跑這個看看。
- `/braid migrate`：正式搬。另外開一個視窗，它會請你從系統匣（macOS 是選單列）**結束 Claude**，
  只關視窗不夠；這個對話會跟著中斷，沒關係。工具備份、搬完，會問要不要重新開啟 Claude。
- 只打 `/braid` 會列出所有動作。

**挑要搬什麼**：視窗會跳出勾選清單，列出舊帳號的**專案資料夾**（各有幾筆對話、最近的是哪一筆）和**已儲存的環境**，
只勾要搬到新帳號的就好；勾完可以選擇再展開，逐筆挑對話。沒勾的留在原帳號，那些資料夾的預設設定也不會跟過去，
個人專案不會被帶進公司帳號。Windows 的清單用 Ctrl+A 全選、Ctrl＋點擊多選；Mac 的清單預設全選，取消不要的即可。

雙擊的方式流程相同；想只看計畫，Windows 加 `-DryRun`、macOS 加 `--dry-run`。
不想跳清單、直接指定的話：Windows `-Projects "資料夾1,資料夾2" -Presets 環境名稱`（`all` 全部、`none` 都不要），
macOS 用 `--projects`、`--presets`。

**寫入前一定要看清楚方向**：視窗會顯示「目前登入（搬到這裡）：你的信箱」，最後問「方向對嗎」，
要輸入 Y 才會寫入（直接按 Enter 不算）。信箱不是你要搬過去的帳號（例如公司信箱），就輸入 N，
到桌面 app 換帳號後再執行。

## 安全

- **只複製、不搬移**：舊帳號的資料原封不動。可以重跑，已經搬過的會略過。
- **寫入前先備份**到 `~/braid-backups/<時間>/`，完成畫面會給還原指令。
- **不需要系統管理員權限**：只讀寫自己的使用者資料夾。
- **app 開著時不寫**：工具會等你結束 app（試跑例外，只讀不寫）。
- **不會搬錯方向**：顯示要搬過去的帳號信箱，要你輸入 Y 確認；app 自己記的兩份「目前帳號」說法不一致時直接停下，不猜。
- **卡住會問，不會直接停掉**：

  | 狀況 | 工具怎麼做 |
  |---|---|
  | app 還開著 | 說明怎麼結束並等你；Windows 可按 K 強制結束（會先確認），macOS 可由工具送出「結束」 |
  | 寫檔失敗（防毒掃描中、檔案被占用） | 問你：重試／略過這一項／全部取消 |
  | WSL 或遠端主機上的對話紀錄確認不到 | 問你：仍要複製嗎 |
  | 讀不了環境資料 | 問你：只搬 session，還是取消 |
  | 公司政策禁止執行 PowerShell 腳本 | 不繞過，請聯絡 IT |

## 平台狀態

- **Windows（含在 WSL 裡用 Claude Code）**：自動測試之外，已用真實資料重演一次遷移，結果與實際狀態逐欄相同。
- **macOS**：遷移邏輯與 Windows 版用同一套測試資料驗證；與 macOS 系統溝通的那一層還沒在 Mac 實機跑過，
  第一次請先用試跑，有問題回報。

## 疑難

- **「找不到目前登入帳號的 session 資料夾」**：還沒用新帳號在 Code 分頁開過對話，見「使用前」。
- **環境顯示「app 的環境資料格式改版了」**：桌面 app 改了資料格式，工具不猜、直接略過環境，請更新工具。
  session 仍會照常搬。
- **看到「已停用指令碼執行」**：公司政策禁止 PowerShell 腳本，請聯絡 IT。
- **「兩處紀錄對目前登入哪個帳號說法不一致」**：打開桌面 app，確認登入的是要搬過去的帳號，在 Code 分頁開一個對話，結束 app 後再跑。
- **輸入 `/braid` 沒反應**：先輸入 `/reload-plugins` 或開新對話。還是沒有的話，可能是你的帳號還沒開放 mod 功能：
  在 `~/.claude/settings.json` 的 `env` 加 `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` 後開新對話；或改用雙擊的方式。

## 開發

`make test` 跑全部測試。結構、驗證方式與不可違反的約束見 [CLAUDE.md](CLAUDE.md)。
