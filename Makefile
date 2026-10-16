.PHONY: test test-tool test-mod typecheck

# desktop-accounts：Claude Code mod（mod/），repo 本身也是它的 marketplace（.claude-plugin/）。
# 遷移工具本體在 mod/tool/，不透過 Claude 也能直接雙擊執行。

# 測試要用 2.1.288 以上的 claude（更舊的測試工具行為不同）。PATH 上的太舊就 make test CLAUDE=<執行檔>
CLAUDE ?= claude
TS_TYPES ?= $(firstword $(wildcard mod/.claude-plugin/types/claude-code/index.d.ts))

# commit 前跑這條：工具兩個平台的測試、WSL 啟動腳本、mod 的 validate 與 plugin test
test: test-tool test-mod

test-tool:
	tests/run-all.sh
	@if command -v powershell.exe >/dev/null; then tests/launch-wsl.sh; fi

test-mod:
	$(CLAUDE) plugin validate . && $(CLAUDE) plugin validate mod && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 $(CLAUDE) plugin test mod

# 型別由引擎在載入 mod 時寫進 mod/.claude-plugin/types/；沒被載入過就沒有，見 CLAUDE.md
typecheck:
	@test -n "$(TS_TYPES)" || { echo "這份 mod 沒被 Claude Code 載入過，沒有型別可查（見 CLAUDE.md 的驗證一節）"; exit 1; }
	npx --yes -p typescript@5.9 tsc -p mod
