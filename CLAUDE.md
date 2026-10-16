# braid — 開發指南

Claude 的多帳號工具。名稱取「辮子」：每個帳號是一股線，使用者的工作是編成的那一條。
三種用法是同一套機制的不同設定，不要各寫一套：

| 用法 | 方向 | 時機 | 範圍 | 狀態 |
|---|---|---|---|---|
| 遷移（migrate） | 單向 | 手動一次 | 勾選的資料夾 | 已完成（桌面 app） |
| 用量切換（switch） | 跟著使用者走 | 到用量門檻時 | 依資料夾規則（同組織／都可以） | 0.2.0：提示＋一鍵用另一個帳號在新視窗接著做 |
| 同步（sync） | 雙向（換帳號時各帶一次） | 換帳號後第一次打開時問 | 勾選的資料夾 | 0.2.0：桌面 app，用遷移工具的 `-From -Projects -Presets folders` |

三種用法共用一份帳號清單（`$.store` 的 `account:<id>`）與同一個遷移工具；寫入桌面 app 資料的規則只在 `mod/tool/spec.json`。
`/braid` 打開面板（帳號、切換、同步、遷移四頁，依使用者選的用法出現），`/braid migrate` 直接開遷移工具。
repo 本身是 marketplace（`.claude-plugin/`），plugin 在 `mod/`。設計稿（八個畫面）：
https://claude.ai/artifact/VV3y5gmG3DH5rvmU5jxHDa

## 結構

```
.claude-plugin/marketplace.json   marketplace，plugin 來源指 ./mod
mod/                              plugin 本體（從 marketplace 安裝時只會複製這個資料夾）
  .claude-plugin/plugin.json
  .claude-plugin/types/           引擎載入 mod 時寫入的型別（gitignore，不要手改）
  hooks/register.tsx              指令、面板四頁、輸入框上方的提示、交接後的防呆；所有 $ 呼叫都在這個檔
  hooks/model.ts                  純邏輯：帳號、用量、門檻、換帳號規則、同步範圍（不碰 $）
  hooks/launch.ts                 遷移工具的參數與開視窗的方式（純函式）
  hooks/terminal.ts               帳號腳本（接著做、新增帳號）開新視窗的方式（純函式）
  hooks/desktop.ts                讀桌面 app 的側欄資料與備份（收一組讀檔函式，不收 $）
  types/index.d.ts                $.state 的契約
  tests/                          claude plugin test：model.test.ts（純邏輯）、braid.test.tsx（終端機與桌面兩種畫面）
  tool/spec.json                  兩個平台共用的遷移規則
  tool/windows/                   migrate.ps1（主流程）、LevelDbLite.cs、migrate.cmd（雙擊）；
                                  secret.ps1（認證管理員）、resume.ps1（接著做）、add-account.ps1（新增帳號）
  tool/macos/                     core.js（與平台無關的主流程）、migrate.js（JXA 介面層）、migrate.command（雙擊）
  tool/cli/                       macOS、Linux、WSL 的帳號腳本：secret.sh、resume.sh、add-account.sh、open-linux.sh、open-wsl.sh
  tool/launch-from-wsl.sh         WSL 裡的 session 開 Windows 的遷移視窗用
tests/                            工具的測試（Node＋classic-level 造資料與驗證）
```

遷移工具放在 `mod/tool/` 而不是 repo 根目錄：從 marketplace 安裝只複製 plugin 資料夾，放外面裝好就找不到。

## 桌面 app 的資料長怎樣（遷移依據）

- **側欄清單**：`<app 資料>/claude-code-sessions/<帳號>/<組織>/local_*.json`，每筆指向
  `~/.claude/projects/**/<cliSessionId>.jsonl`；另有 `archived-sessions.idx` 與刪除墓碑 `deleted_<uuid>`。
- **已儲存的環境**：正本在 `<app 資料>/Local Storage/leveldb`，鍵
  `_https://claude.ai\0\1persisted.ccd-session-presets.<帳號>`，值＝0x01＋latin1（或 0x00＋UTF-16LE）的
  zustand JSON `{state:{presets,placeDefaults,startedPlaces,…},version:4}`。`ccd-session-presets.json`
  只是副本：app 每次啟動用 Local Storage 覆寫它，只改副本會被蓋回（2026-10-16 實測）。
- **目前帳號**：`<app 資料>/config.json` 的 `lastKnownAccountUuid`。
- `<app 資料>`：Windows `%APPDATA%\Claude`，macOS `~/Library/Application Support/Claude`。

## 驗證

- **commit 前跑 `make test`**：工具兩個平台、LevelDB 邊界、WSL 啟動腳本、mod 的 validate 與 plugin test。
  Windows 版的測試要在 WSL 裡跑（叫得到 `powershell.exe`）。
- **CI**（GitHub Actions，Ubuntu）跑同一條 `make test`，Windows 那段自動略過。改到測試腳本時先在本機模擬：
  PATH 拿掉 `/mnt/` 底下的路徑，**再把 `wslpath`、`cmd.exe` 頂替成「找不到」**（WSL 自己的 `wslpath` 在
  `/usr/bin`，只拿掉 `/mnt/` 抓不到；2026-10-16 就漏在這裡，CI 紅一次）。不要頂替 `powershell.exe`，
  否則「有沒有 PowerShell」的判斷會以為有。
- 工具測試用同一份假資料（`tests/fixture.mjs`）、同一支驗證程式（`tests/verify.mjs`）驗兩個平台：
  改了一邊的流程，另一邊要跟著改，測試會抓到不一致。
- **選擇流程的測試**：勾選視窗（Windows 的 Out-GridView、Mac 的 choose from list）無法自動點，
  所以設了測試替身：環境變數 `BRAID_TEST_PICKS`（例如 `2,4,6;1`＝第一步選第 2、4、6 列，展開後選第 1 列）
  代替視窗回傳選到的列，其餘走真實程式路徑。傳給 Windows 的 `powershell.exe` 要經 `WSLENV`。
  視窗本身只能請人實際點一次。
- **真實資料重演**（改到讀寫邏輯時做一次）：把桌面 app 資料的備份解到暫存的 `app/`，用
  `-AppDataRoot` 指過去跑，再把結果跟實際遷移後的狀態比。真實資料含私人內容，跑完刪掉、不進 repo。
- macOS 的 JXA 介面層（`migrate.js` 的 ObjC 呼叫）只能在 Mac 實機驗；這裡只驗語法與 base64。
- `make typecheck` 需要 `mod/.claude-plugin/types/`，引擎載入過 mod 才有。沒有時可用 plugin-authoring
  skill 附的 `claude-code.d.ts` 配它開頭的 tsconfig，放在 mod 資料夾外面檢查。

## 不可違反的約束

- **app 開著時不寫**：作用中帳號的清單與 Local Storage 都在 app 記憶體裡，寫了會被蓋回。
  Windows 的 LevelDB 寫入用獨佔開檔，app 開著會失敗，是第二道保險。
- **只複製、不搬移，寫入前備份**；重跑必須是安全的（已有的略過）。
- **格式認不得就停**：Local Storage 版本不在 `spec.json` 的 `supportedVersions`、LevelDB 校驗不過，
  一律放棄寫環境並說明，不猜。
- **卡住改成問**：任何可能失敗的步驟都包在「重試／略過／取消」裡；公司政策（強制簽章、受限語言模式）不繞過。
- **遷移邏輯不靠模型**：`/braid migrate` 只開視窗，讀寫全在工具裡；工具也能不透過 Claude 直接雙擊。
- **資料夾設定只跟著選擇走**：有挑選時，資料夾預設值、最近使用位置只帶選到的專案與環境的資料夾，
  個人專案不能因為「順便」被帶進公司帳號。同步的「全部資料夾」是使用者明確選的（`-Projects all -Presets all`），
  兩個帳號的組織不確定相同時面板要警告；範圍只由 `model.ts` 的 `syncRequest` 決定，同步頁與換帳號後的提示共用。
- **規則只寫在 `spec.json`**：要拿掉哪些欄位、認得哪些版本，兩個平台都讀它。
- **登入憑證不經過 mod 與模型**：新增帳號、接著做都在新開的視窗裡由 `tool/cli`、`tool/windows` 的腳本取用；
  結果檔只寫成功與否和存在哪裡。mod 只知道憑證 id（`tok-xxxxxxxx`）。
- **接著做用 `--fork-session`**：複製一份新的對話，原本的不動，兩個行程不會寫同一份紀錄。
  憑證在 macOS／Linux／WSL 經由 `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` 交出去（Claude Code 讀完會刪變數，
  管道也讀空，對話裡執行的指令拿不到）；Windows 沒有這個機制，只能放那個視窗的 `CLAUDE_CODE_OAUTH_TOKEN`。
- **不繞過公司政策**：policy 設了 `forceLoginOrgUUID` 就不讓新增帳號（查不出憑證屬於哪個組織）。
  組織不明的帳號在「只換同組織」的資料夾一律不算同組織。
- **測試碰不到真的工具**：會真的啟動 Windows 程式的測試（`launch-wsl.sh` 的實跑那段），先刪掉複製出去的真工具、
  用字面字串替換路徑、執行前斷言指令只指向 dump。2026-10-16 這裡的 bash 樣式替換遇到反斜線靜默失敗，
  真的遷移工具在隱藏視窗跑起來過（停在等 app 結束，沒有寫入）。

## 坑

- **名稱不能用 `claude-`／`anthropic-` 開頭**：plugin validate 會擋（保留給官方，避免被誤認），
  所以不叫 claude-account；命名過程試過 switchboard、mycelium 等，2026-10-16 定為 `braid`。
- **mod 裡 `$` 不能經由資料結構傳遞，也不能傳過 import**：動作的分派寫成 `switch`；`$` 只能傳給同一個檔裡的函式。
  別的檔需要讀檔或執行指令時，在 register.tsx 用 `$` 組一組函式傳過去（見 `desktop.ts` 的 `DesktopIo`）；
  `$.env.get` 的變數名稱一定要寫成字面字串，所以環境變數也在 register.tsx 先讀好再傳。
- **JSX 檔裡不能有叫 `h` 的變數**：JSX 編譯成全域的 `h(...)`，同名的區域變數會把它蓋掉，hook 直接被跳過。
- **測試套件裡沒有東西墊底**：`session.start`、`session.measure`、`prompt.submit`、`command.register`、
  沒畫東西時的 `ui.render`、`store.*` 都要測試自己答（生命週期事件直接回結果，`$` 名詞的事件回 `{ value }`）。
  測試裡的 `$` 也沒有 `store`，要讀寫儲存就自己記（見 `braid.test.tsx` 的 `world`）。
- **PowerShell 在同一個行程裡呼叫另一支 .ps1**，成功時不會設 `$LASTEXITCODE`（還是 `$null`，`$null -ne 0` 成立），
  要看輸出內容判斷。**標準輸入被導向時 `Read-Host` 不讀它**，會一直等：要讓腳本能自動測試，
  在 `[Console]::IsInputRedirected` 時改讀 `[Console]::In`（見 `add-account.ps1` 的 `Read-Line`）。
- **這台開發機的 `find` 是 bfs**：不吃 `-newermt '-20 minutes'`，報錯時沒有輸出，接 `wc -l` 會得到 0，
  看起來像「沒有檔案被改」。要看修改時間用 `stat -c '%y'` 排序。

- **Windows PowerShell 5.1 把沒有 BOM 的 UTF-8 當 Big5 讀**：中文註解會吞掉下一行程式碼（參數全空就是這個）。
  `.ps1`、`.cs` 一律存 UTF-8 BOM，`run-windows.sh` 開頭會檢查。
- **`migrate.js` 只用 ASCII**：`osascript` 不一定用 UTF-8 讀腳本；中文全放 `core.js`（以 UTF-8 讀進來再 eval）。
- **LevelDB 在 `/mnt/c` 上開鎖檔不穩**：測試在 WSL 本機造資料、驗證前複製回本機再開。
- **`launch-from-wsl.sh` 要先把工具複製到 Windows 暫存再開**：`cmd.exe` 不支援 `\\wsl.localhost` 當工作目錄，
  而且結束 Claude 後 WSL 可能關掉。視窗用 `Start-Process` 開，是獨立行程，結束 Claude 不會一起關。
- 官方的 `claude --desktop --resume` 與 `claude://resume?session=` 對 WSL 不通：前者在 Linux 直接拒絕，
  後者的匯入只去 Windows 端找對話紀錄。
