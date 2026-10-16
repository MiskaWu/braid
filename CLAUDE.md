# braid — 開發指南

Claude 的多帳號工具。名稱取「辮子」：每個帳號是一股線，使用者的工作是編成的那一條。
三種用法是同一套機制的不同設定，不要各寫一套：

| 用法 | 方向 | 時機 | 範圍 | 狀態 |
|---|---|---|---|---|
| 遷移（migrate） | 單向 | 手動一次 | 全部 | 已完成（桌面 app） |
| 用量切換（use） | 跟著使用者走 | 每次切換時 | 全部或最近用的 | 規劃中；CLI 終局＝多個帳號同時登入、只做切換，Linux 也要支援 |
| 同步（sync） | 雙向 | 持續 | 依資料夾規則 | 規劃中 |

底層共用一張「哪些資料、怎麼合併、什麼時候能寫」的登記表（目前是 `mod/tool/spec.json`）。
對話裡的指令與命令列版共用動作名稱：`/braid <動作>` 對應 `braid <動作>`。
repo 本身是 marketplace（`.claude-plugin/`），plugin 在 `mod/`。

## 結構

```
.claude-plugin/marketplace.json   marketplace，plugin 來源指 ./mod
mod/                              plugin 本體（從 marketplace 安裝時只會複製這個資料夾）
  .claude-plugin/plugin.json
  .claude-plugin/types/           引擎載入 mod 時寫入的型別（gitignore，不要手改）
  hooks/register.ts               /braid <動作>；動作表 ACTIONS＋switch 分派；migrate 偵測平台、開獨立視窗跑工具
  hooks/launch.ts                 平台 → 要執行的動作（純函式）
  tests/                          claude plugin test
  tool/spec.json                  兩個平台共用的遷移規則
  tool/windows/                   migrate.ps1（主流程）、LevelDbLite.cs（LevelDB 讀與追加寫）、migrate.cmd（雙擊）
  tool/macos/                     core.js（與平台無關的主流程）、migrate.js（JXA 介面層）、migrate.command（雙擊）
  tool/launch-from-wsl.sh         WSL 裡的 session 開 Windows 視窗用
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
- **規則只寫在 `spec.json`**：要拿掉哪些欄位、認得哪些版本，兩個平台都讀它。

## 坑

- **名稱不能用 `claude-`／`anthropic-` 開頭**：plugin validate 會擋（保留給官方，避免被誤認），
  所以不叫 claude-account；命名過程試過 switchboard、mycelium 等，2026-10-16 定為 `braid`。
- **mod 裡 `$` 不能經由資料結構傳遞**（放進物件再呼叫會讓模組載入失敗）：動作的分派寫成 `switch`，
  直接呼叫模組裡的函式並傳 `$` 則可以。

- **Windows PowerShell 5.1 把沒有 BOM 的 UTF-8 當 Big5 讀**：中文註解會吞掉下一行程式碼（參數全空就是這個）。
  `.ps1`、`.cs` 一律存 UTF-8 BOM，`run-windows.sh` 開頭會檢查。
- **`migrate.js` 只用 ASCII**：`osascript` 不一定用 UTF-8 讀腳本；中文全放 `core.js`（以 UTF-8 讀進來再 eval）。
- **LevelDB 在 `/mnt/c` 上開鎖檔不穩**：測試在 WSL 本機造資料、驗證前複製回本機再開。
- **`launch-from-wsl.sh` 要先把工具複製到 Windows 暫存再開**：`cmd.exe` 不支援 `\\wsl.localhost` 當工作目錄，
  而且結束 Claude 後 WSL 可能關掉。視窗用 `Start-Process` 開，是獨立行程，結束 Claude 不會一起關。
- 官方的 `claude --desktop --resume` 與 `claude://resume?session=` 對 WSL 不通：前者在 Linux 直接拒絕，
  後者的匯入只去 Windows 端找對話紀錄。
