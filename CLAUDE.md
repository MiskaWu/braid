# braid — 開發指南

Claude 的多帳號工具。名稱取「辮子」：每個帳號是一股線，使用者的工作是編成的那一條。
三種用法是同一套機制的不同設定，不要各寫一套：

| 用法 | 方向 | 時機 | 範圍 | 狀態 |
|---|---|---|---|---|
| 遷移（migrate） | 單向 | 手動一次 | 勾選的資料夾 | 已完成（桌面 app） |
| 用量切換（switch） | 跟著使用者走 | 到用量門檻時 | 全部資料夾（不看歸屬） | 0.2.0：提示＋一鍵用另一個帳號在新視窗接著做 |
| 同步（sync） | app 登入的帳號 → 同一對的另一個（換帳號後方向跟著反過來） | 自動：約每分鐘、到用量門檻時馬上一次 | 全部或挑的資料夾 | 0.3.0：側欄紀錄由 mod 自己寫（`hooks/mirror.ts`）；環境要結束 app，交給遷移工具 |

三種用法共用一份帳號清單（`$.store` 的 `account:<id>`）與同一個遷移工具；寫入桌面 app 資料的規則只在 `mod/tool/spec.json`。
第四個用法「歸屬」（policy）不是另一股線：它只決定新頁（artifact）用哪個帳號發布，不管對話往哪個帳號走。
同步優先、歸屬輔助（2026-10-20 拍板），見「坑」的「歸屬只管新頁」。
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
  hooks/terminal.ts               帳號腳本（接著做、新增帳號）開新視窗的方式、去哪裡找 claude（純函式）
  hooks/desktop.ts                讀桌面 app 的側欄資料與備份（收一組讀檔函式，不收 $）
  hooks/mirror.ts                 自動同步的核心：把側欄紀錄複製到沒登入的帳號（收一組讀寫檔函式，不收 $）
  hooks/visual.ts                 桌面版面板的圖（頁首、帳號卡、用量條、切換總覽與名次列、同步卡、歸屬總覽、用法插圖）：給資料回 SVG 字串的純函式
  hooks/policy.ts                 歸屬表：資料夾 → 新頁歸哪個帳號、對得上與否、git 遠端分組（純邏輯）
  hooks/pages.ts                  頁面清單（~/.claude/artifact-sources/index.json）的格式與判斷（純邏輯）
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

- **app 開著時不寫作用中帳號**：作用中帳號的清單與 Local Storage 都在 app 記憶體裡，寫了會被蓋回。
  Windows 的 LevelDB 寫入用獨佔開檔，app 開著會失敗，是第二道保險。
  例外是自動同步：它只寫**沒登入**的帳號的側欄資料夾。依據是 app 2.42304 的 `LocalSessionManager.doInitialize`：
  帳號或組織一變就 `flushPendingSaves` 舊的、`sessions.clear()`、再 `loadSessions` 從磁碟讀新帳號的資料夾；
  哪個帳號作用中看 app 的 `config.json` 的 `lastKnownAccountUuid`（換帳號當下就改）。app 改版後這段要重查。
  同步的對象由 `model.ts` 的 `mirrorTarget` 決定，它保證不會是作用中的帳號；但那只是開始同步那一刻的判斷，
  所以 `mirror.ts` 每寫一筆、刪一筆之前還要問 `MirrorIo.stillInactive()`（重讀 `config.json`），目標被登入了就停
  （2026-10-20 實測：只在開始時看一次，換帳號後剩下 5 筆有 4 筆照樣寫進作用中的帳號）。
  從 braid 移除同步夥伴的帳號時，同步跟著關掉、這一對清掉（`forget`），不再往它的資料夾寫。
  刪除只依作用中帳號資料夾裡明確的 `deleted_<id>`（app 刪對話時寫，內容是刪除時間），刪前先備份到
  `braid-backups/sync-deleted/`、刪後留同樣時間的 `deleted_<id>`；目標那筆最後活動晚於刪除時間就不刪。
  app 刪對話本身會停程序、刪 worktree 與分支（共用的），WSL 的對話檔不刪（`holdsLocalTranscripts` 只認 local）。
- **清舊備份只落在兩個地方**：`sync-deleted/<帳號>/<組織>/` 裡的檔（看修改時間）與 `braid-backups/<時間>`
  資料夾（留最新幾份）。遞迴刪除只經過 `terminal.ts` 的 `removeToolBackup`：它只收資料夾名稱、自己組路徑、
  名稱不符 `TOOL_BACKUP_NAME` 就丟錯，不要另外寫一條收完整路徑的遞迴刪除。保留天數與份數由使用者在面板選（`$.store` 的 `keep`）。
- **只複製、不搬移，寫入前備份**；重跑必須是安全的（已有的略過）。
- **格式認不得就停**：Local Storage 版本不在 `spec.json` 的 `supportedVersions`、LevelDB 校驗不過，
  一律放棄寫環境並說明，不猜。
- **卡住改成問**：任何可能失敗的步驟都包在「重試／略過／取消」裡；公司政策（強制簽章、受限語言模式）不繞過。
- **遷移邏輯不靠模型**：`/braid migrate` 只開視窗，讀寫全在工具裡；工具也能不透過 Claude 直接雙擊。
- **資料夾設定只跟著選擇走**：有挑選時，資料夾預設值、最近使用位置只帶選到的專案與環境的資料夾，
  個人專案不能因為「順便」被帶進公司帳號。同步的「全部資料夾」是使用者明確選的，兩個帳號的組織不確定相同時面板要警告；
  範圍只由 `BraidSync` 的 `all`／`folders` 決定：自動同步用 `mirrorTarget`、帶環境的按鈕用 `syncRequest`（`-Projects all -Presets all` 或 `-Presets folders`）。
- **規則只寫在 `spec.json`**：要拿掉哪些欄位、認得哪些版本，兩個平台的工具與 mod 的自動同步都讀它。
  自動同步更新已有的紀錄時，`dropKeys`、`nullKeys`、`replaceFromTarget` 留目標帳號自己的值（它們綁帳號）。
- **登入憑證不經過 mod 與模型**：新增帳號、接著做都在新開的視窗裡由 `tool/cli`、`tool/windows` 的腳本取用；
  結果檔只寫成功與否和存在哪裡。mod 只知道憑證 id（`tok-xxxxxxxx`）。
- **接著做用 `--fork-session`**：複製一份新的對話，原本的不動，兩個行程不會寫同一份紀錄。
  憑證在 macOS／Linux／WSL 經由 `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` 交出去（Claude Code 讀完會刪變數，
  管道也讀空，對話裡執行的指令拿不到）；Windows 沒有這個機制，只能放那個視窗的 `CLAUDE_CODE_OAUTH_TOKEN`。
- **新增帳號用組織判斷是誰**：一年期憑證（setup-token）打 `/api/oauth/profile` 會被拒（403 permission_error，
  2026-10-17 用真的憑證驗過；假憑證是 401，只用假的測不出來）。改由 `org.sh`／`org.ps1` 用憑證打公開的
  `GET /v1/models?limit=1`（不算用量、不用指定模型），讀回應標頭 `anthropic-organization-id`；只查得到組織。
  面板用 `model.ts` 的 `classifyOrg`：和目前帳號同組織＝多半就是目前帳號（預設刪憑證，另按確認才加入）、
  正好一個認得的帳號在該組織＝更新它的憑證、其他＝新帳號。測試用 `tests/fixtures/fake-api.py`（只聽 127.0.0.1），
  腳本的 `BRAID_API_BASE` 只接受 `http://127.0.0.1:<埠>`。
- **不繞過公司政策**：policy 設了 `forceLoginOrgUUID` 就不讓新增帳號（新增前沒辦法知道會登入哪個組織）。
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
- **`$.state` 在外掛更新、重新載入後還留著上一版寫的值**（`$.store` 的設定每次 `loadStore` 會重新整理，`$.state` 不會）。
  0.3.2 更新後面板整片空白，就是 0.3.1 的桌面資料沒有 `trash` 欄位。從磁碟讀來的暫存（`desktopAtom`）在 `session.start` 一律清掉，
  再在背景重讀；改了某個 atom 的形狀，就要嘛在這裡一起清、要嘛讀的地方能接受舊形狀。面板的分頁畫壞時會顯示原因和「重新讀取」，
  不會整片空白。測試的 `$` 碰不到 `$.state`：模擬舊值要攔 `state.get`（見 `braid.test.tsx` 的「更新之後」），
  攔下的讀取不算在測試工具的重畫追蹤裡，之後要自己 `ui.redraw()`。
- **桌面版畫成 SVG，終端機照舊是文字**：判斷看 `e.surface`，不能看元件表裡有沒有 `Svg`——終端機的表也有，畫成一塊空白
  （0.4.0 開發時帳號卡在終端機整張變空白，靠同時測終端機的測試抓到）。SVG 不會換行：長說明留給原生 Text，
  圖裡只放短字並用 `fit` 截斷；使用者取的名稱一律經過 `esc`。深淺色寫在 SVG 自己的 `<style>`（`prefers-color-scheme`），
  帳號色是 Claude 設計系統的類別色前五個（`model.ts` 的 `SLOTS`，用 dataviz 驗證器在深淺兩種底色驗過；改顏色或順序要重跑）。
  桌面 app 面板的底色是 `#1a1a19`，和設計系統的深色底一樣。設計稿的預覽方法：把產生器的輸出放進 462px 寬的頁面，
  用 Playwright 分別以深、淺色截圖來看。
- **歸屬只管新頁，不管對話**：資料夾 → 帳號（`$.store` 的 `policy`），「對得上」看同一個帳號或同一個組織。
  它唯一的用途是讓新頁（artifact）用對的帳號發布，所以換帳號候選（`candidates`）、自動同步的範圍、輸入框上方的提示都不看它。
  0.6.2 以前歸屬也管對話（對不上就警告、換帳號要確認），四種用法全開時會打架：同步把公司資料夾的對話帶到個人帳號、
  用量提示建議換過去，換過去之後歸屬又跳「公司程式碼會經由個人帳號送出」——同一個 braid 前一秒建議、後一秒警告。
  使用者拍板同步優先（2026-10-20），對話層的警告、「這次就用目前帳號」、換帳號的風險確認都拆掉了；不要加回來。
  還沒設定的資料夾只在**有新頁被擋下排隊**時才在輸入框上方問歸誰（`askHere`）；選這個對話這一邊（或不分）就寫回表並直接發布
  （`answerAsk`），選別的帳號就只寫表、頁留著等它。測試的 `USES_ALL` 要四個都開：以前少了 `policy`，「全開」的情境都沒測到歸屬。
  新頁攔截掛 Artifact 的 `tool.call`，判斷出錯時寧可不發布（`.catch` 回 deny）：頁面歸錯帳號事後不能轉移。
  braid 自己替使用者發布排隊的頁時用 `publishingNow` 放行。待發布清單用檔案（`~/.claude/artifact-sources/index.json`），
  因為發布用終端機是另一個 `CLAUDE_CONFIG_DIR`，讀不到這邊的 `$.store`。官方只保證 `/login` 的對話能發布，
  braid 用一年期憑證開的視窗（`BRAID_ACCOUNT`）不給「發布」。CLI 自己 `/login` 的帳號（`~/.claude.json`）
  沒有 braid 的憑證也能「接著做」：腳本收到憑證 id「-」就不帶憑證直接開 claude。
- **桌面版版面**：可以點的一定是原生的 Button／Select／Input（Button 只能包文字，不能包圖），圖（Svg）只負責呈現狀態。
  每頁同一套：頁首圖 → 分頁按鈕 → 頁首（標題＋一句話）→ 總覽圖 → 區塊；長說明收進可展開的「說明」（`helpAtom`）。
  設計稿先在暫存資料夾用產生器輸出拼 462px 寬的假面板、Playwright 深淺色截圖看過再接進來。
- **用量顯示**：狀態列（`$.ui.status`）只能放文字，寫 5 小時與 7 天；桌面版另外在輸入框下方那行（`PromptHint`）
  先拿 `next(e)` 畫好的 app 提示，再在旁邊接 `usageStrip` 的 SVG 量表，不蓋掉 app 自己的提示。
- **找 claude 只有一個地方**：新增帳號、接著做、面板內更新都經 `register.tsx` 的 `findClaude`（找的順序在 `terminal.ts`
  的 `claudeLookup`：跑這個對話的那支、PATH、常見安裝位置、桌面 app 自帶的、新版先），交給視窗的一律是完整路徑。
  只靠 `CLAUDE_CODE_EXECPATH` 不夠：2026-10-19 有人在只裝桌面 app 的 Windows 上，面板拿不到這個變數、交了裸的 `claude`，
  按了 Enter 才看到「無法辨識 'claude' 詞彙」。WSL 開的視窗是 `wsl.exe -e bash`、不讀 `.bashrc`，裸名稱也常找不到。
  桌面 app 自帶的 claude 可以單獨跑（Windows 在 `%APPDATA%\Claude\claude-code\<版本>\<雜湊>\claude.exe`，
  WSL 在 `~/.claude/remote/ccd-cli/<版本>`）。npm 安裝時 `CLAUDE_CODE_EXECPATH` 是 node，不拿來用。
  都找不到就不開視窗，面板給官方安裝指令（`claudeInstall`）；腳本開頭也再確認一次，不見了就寫結果檔 `no-claude`。
- **更新**：官方是 `/plugin` 裡打開 marketplace 的自動更新（第三方預設關，`marketplace.json` 不能替使用者開）。
  braid 另外自己查 GitHub 上 `mod/.claude-plugin/plugin.json` 的版本，按鈕照官方兩步更新後用
  `$.command.run({ command: 'reload-plugins' })` 重新載入。改 repo 位置或 marketplace 名稱要改 `register.tsx` 的 `LATEST_URL`、`MARKETPLACE`。
- **JSX 檔裡不能有叫 `h` 的變數**：JSX 編譯成全域的 `h(...)`，同名的區域變數會把它蓋掉，hook 直接被跳過。
- **測試套件裡沒有東西墊底**：`session.start`、`session.measure`、`prompt.submit`、`command.register`、
  沒畫東西時的 `ui.render`、`store.*` 都要測試自己答（生命週期事件直接回結果，`$` 名詞的事件回 `{ value }`）。
  測試裡的 `$` 也沒有 `store`，要讀寫儲存就自己記（見 `braid.test.tsx` 的 `world`）。
- **PowerShell 在同一個行程裡呼叫另一支 .ps1**，成功時不會設 `$LASTEXITCODE`（還是 `$null`，`$null -ne 0` 成立），
  要看輸出內容判斷。**標準輸入被導向時 `Read-Host` 不讀它**，會一直等：要讓腳本能自動測試，
  在 `[Console]::IsInputRedirected` 時改讀 `[Console]::In`（見 `add-account.ps1` 的 `Read-Line`）。
- **修改腳本不要用巢狀 heredoc**：外層 `<<'EOF'` 裡的字串若有一行 `EOF`（例如測試裡的假程式），外層會在那裡提早結束，
  剩下的行被 shell 當指令跑（2026-10-16 發生過，變數是空的，`$T/bin/curl` 變成 `/bin/curl`，因為沒有權限才沒寫進去）。
  長的修改腳本先用 Write 寫成檔案再執行，內層 heredoc 用不同的結束字。
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
