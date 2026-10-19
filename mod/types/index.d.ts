// braid 的狀態契約。設定與帳號存在 $.store（跨對話），畫面讀的是這裡的 $.state（這個對話）；
// 兩邊由 hooks/register.tsx 的 persist 一起寫，載入時從 $.store 讀回來。

/** 一個時間窗的用量：0–100（超用的花費上限可能超過 100），什麼時候重置。 */
export type BraidWindow = { pct: number; resetsAt: string | null }

/** 某個帳號最後一次量到的用量。 */
export type BraidUsage = { fiveHour: BraidWindow | null; sevenDay: BraidWindow | null; at: number }

/** 存放登入憑證的地方；null＝braid 沒有它的憑證（只在桌面 app 或 CLI 自己登入時看過）。 */
export type BraidCredential = 'keychain' | 'secret-service' | 'file' | 'credman'

export type BraidAccount = {
  /** Anthropic 的帳號 uuid；用 braid 加進來、還不知道 uuid 的帳號是 tok-xxxxxxxx */
  id: string
  email: string | null
  orgId: string | null
  orgName: string | null
  label: string
  color: string
  /** 從哪裡認得它：桌面 app、CLI 自己的登入、braid 新增的憑證 */
  source: 'desktop' | 'cli' | 'token'
  credential: BraidCredential | null
  /** 憑證存在哪個 id 底下（新增時的 tok-xxxxxxxx）；用信箱併進既有帳號時與 id 不同 */
  credentialId: string | null
  usage: BraidUsage | null
  lastSeen: number
}

export type BraidUses = { migrate: boolean; switch: boolean; sync: boolean; policy: boolean }

export type BraidSwitch = {
  on: boolean
  /** 5 小時用量達到幾 % 提醒 */
  fiveHour: number
  /** 7 天用量達到幾 % 提醒；null＝不看 7 天 */
  sevenDay: number | null
  /** 換帳號的順序（帳號 id），沒列到的排在後面 */
  order: string[]
}

/** 歸屬表的一條：這個資料夾（含子資料夾）歸哪個帳號（帳號 id；「*」＝不分）。 */
export type BraidRule = { folder: string; owner: string }
export type BraidPolicy = { rules: BraidRule[] }

/** 這個對話裡「這次就用目前帳號」：只算這一次，不寫回表。 */
export type BraidOverride = { project: string; account: string }

export type BraidSync = {
  /** 開著就自動同步：桌面 app 現在登入的是其中一個時，它的對話隨時複製到另一個 */
  on: boolean
  /** 一起同步的兩個帳號 */
  pair: string[]
  /** true＝全部資料夾（預設，之後新出現的也算）；false＝只同步 folders。切回全部時 folders 留著 */
  all: boolean
  folders: string[]
}

/** 自動同步沒做成的原因：找不到桌面 app、讀不到它登入誰、讀不到規則、對方帳號沒有資料夾、寫入失敗。 */
export type BraidMirrorProblem = 'no-desktop' | 'no-active' | 'no-spec' | 'no-target' | 'failed'

/** 自動同步最近一次的結果。 */
export type BraidMirror = {
  at: number
  /** 桌面 app 現在登入的帳號（app 的 config.json）；讀不到是 null */
  active: string | null
  /** 複製到哪個帳號、它的組織資料夾（叫名稱用）；這次沒有對象是 null */
  to: string | null
  toOrg: string | null
  created: number
  updated: number
  deleted: number
  problem: BraidMirrorProblem | null
  /** 寫入失敗時的訊息 */
  detail: string | null
}

/** braid 自己的新版：裝的版本、GitHub 上的版本、按了更新之後到哪一步。 */
export type BraidUpdate = {
  installed: string | null
  latest: string | null
  step: 'idle' | 'running' | 'failed'
  message: string | null
}

/** 備份留多久：同步刪掉的對話備份留幾天、遷移工具的整份備份留最新幾份；null＝一直留著。 */
export type BraidKeep = { deletedDays: number | null; toolCopies: number | null }

export type BraidTab = 'accounts' | 'switch' | 'sync' | 'policy' | 'migrate'

export type BraidPlatform = 'wsl' | 'windows' | 'mac' | 'other'

/** 桌面 app 一個帳號（某個組織底下）的側欄對話，依資料夾彙總。 */
export type BraidFolder = { path: string; sessions: number; lastActivity: number }
export type BraidProfile = { account: string; org: string; sessions: number; lastActivity: number; folders: BraidFolder[] }
export type BraidBackup = { name: string; dir: string }
/** 備份資料夾（給人看的寫法）、遷移工具的整份備份、同步刪掉的對話備份有幾筆多大。 */
export type BraidDesktop = {
  profiles: BraidProfile[]
  backups: BraidBackup[]
  backupRoot: string | null
  trash: { count: number; bytes: number }
  error: string | null
}

/** 新增帳號的進度：開視窗登入 → 等結果檔 → 填名稱。 */
export type BraidAdd =
  | { step: 'blocked'; reason: string }
  | { step: 'waiting'; id: string; resultPath: string; startedAt: number }
  /** orgId：新增帳號的腳本用憑證查到的組織（一年期憑證只查得到組織）；查不到是 null */
  | { step: 'confirm'; id: string; credential: BraidCredential; orgId: string | null }
  /** command：要使用者自己執行的指令（找不到 claude 時是安裝指令），面板顯示並給複製鈕 */
  | { step: 'failed'; reason: string; command?: string }

export type BraidAddForm = { label: string; email: string; org: string }

/** 這個對話已經交給另一個帳號接著做；confirmed＝使用者已確認仍要在這裡繼續。 */
export type BraidHandoff = { account: string; label: string; confirmed: boolean; noticed: boolean }

declare module 'claude-code' {
  interface PluginState {
    braid: {
      platform: BraidPlatform | null
      uses: BraidUses | null
      draftUses: BraidUses
      tab: BraidTab
      accounts: Record<string, BraidAccount>
      current: string | null
      live: BraidUsage | null
      switch: BraidSwitch
      sync: BraidSync
      desktop: BraidDesktop | null
      add: BraidAdd | null
      addForm: BraidAddForm
      editing: string | null
      notice: string | null
      handoff: BraidHandoff | null
      snooze: string | null
      mirror: BraidMirror | null
      keep: BraidKeep
      update: BraidUpdate | null
      policy: BraidPolicy
      /** CLI 自己 /login 的帳號（~/.claude.json）：braid 沒有它的憑證也能用它接著做 */
      cliLogin: string | null
      override: BraidOverride | null
      /** 要確認風險才接手的帳號（按了第一次，等第二次） */
      confirming: string | null
      /** 頁面清單（~/.claude/artifact-sources/index.json）讀進來的樣子 */
      pages: { pending: number; list: { id: string; title: string; project: string; owner: string | null; url: string | null; status: string }[] } | null
      /** 歸屬頁「其他資料夾」要歸給誰 */
      newOwner: string | null
      /** 展開的說明（例如同步頁的「怎麼運作」）；null＝都收著 */
      help: string | null
      /** 這個對話是 braid 用一年期憑證開的（官方只保證 /login 的對話能發布頁面） */
      viaToken: boolean
      /** 這個對話裡按過「之後再說」的專案（不再問歸屬） */
      skipAsk: string | null
      /** 草稿：依 git 遠端分組的專案資料夾 */
      draft: { key: string | null; folders: string[] }[] | null
      tz: number
    }
  }
}
