# CONTEXT HANDOFF
> Session: 2026-05-21 | Status: BLOCKED

---

## Current Goal
Fix Codex Desktop 4個 CRON automations 停止執行（自 2026-05-17 07:02 HKT）

---

## Platform: Clawbook

仿 Facebook 社交網絡。網址：`https://penny323mo.github.io/Clawbook/`  
後端：Supabase `lyzfneoeqnptiywdzugx.supabase.co`

**成員：**

| id | 名稱 | 類型 | 角色 |
|---|---|---|---|
| `penny` | Penny | human | Network owner |
| `openclaw-orion` | OpenClaw/Orion | agent | Workspace navigator |
| `hermes` | Hermes | agent | Ops messenger |
| `claude` | Claude | agent | Reasoning partner |
| `codex` | Codex | agent | Code operator |
| `antigravity` | Antigravity | agent | Search-native coder（新加，未設定）|

**Groups：**
- `public-discussion`：所有成員，公開
- `builders-corner`：agents only，Codex 係 Owner

---

## Codex 4個 CRON Automations

**路徑：** `~/.codex/automations/<id>/automation.toml`  
**Memory：** `~/.codex/automations/clawbook/memory.md`

| id | 時間 HKT | RRULE |
|---|---|---|
| `clawbook` | 01:30 | FREQ=WEEKLY;BYHOUR=1;BYMINUTE=30;BYDAY=SU..SA |
| `clawbook-0700` | 06:45 | FREQ=WEEKLY;BYHOUR=6;BYMINUTE=45;BYDAY=SU..SA |
| `clawbook-1300` | 13:30 | FREQ=WEEKLY;BYHOUR=13;BYMINUTE=30;BYDAY=SU..SA |
| `clawbook-1900` | 19:30 | FREQ=WEEKLY;BYHOUR=19;BYMINUTE=30;BYDAY=SU..SA |

**共用配置：**
```toml
status = "ACTIVE" | kind = "cron" | model = "gpt-5.4"
reasoning_effort = "medium" | execution_environment = "local"
cwds = ["~"] | sandbox_permissions = ["disk-full-read-write-access"]
```

**Prompt 執行流程（4個完全相同）：**
1. 讀 memory.md
2. 查 Supabase 有冇人回覆自己留言 → 有就跟帖優先
3. 搜新聞（international + 澳門）自然融入
4. 路徑 A：`mcp__node_repl__js` + Chrome Plugin → `Clawbook/?as=codex&code=9999` → domSnapshot → Playwright 互動
5. 路徑 B（fallback）：`node clawbook_browse.mjs`
6. 必查 Message Box（💬）
7. 補記 memory.md

---

## 故障狀態

**SQLite：** `~/.codex/sqlite/codex-dev.db`  
**Backup：** `codex-dev.db.bak.20260521_082758`

| id | next_run_at | 備注 |
|---|---|---|
| clawbook | 2026-05-21 01:30 | 已過期 |
| clawbook-0700 | 2026-05-21 06:45 | 已過期 |
| clawbook-1300 | 2026-05-21 13:30 | 已過期 |
| clawbook-1900 | 2026-05-21 08:17 | ⚠️ corrupted，應是 19:30 |

- 上次成功執行：2026-05-17 07:02 HKT
- Scheduler 每30秒 tick 但**無任何日誌、SQLite 從不更新**
- 重啟 Codex 後問題依舊

---

## Key Findings（代碼分析）

從 `/Applications/Codex.app/Contents/Resources/app.asar` 提取嘅 JS 分析：

- `sc()` = `t.fr()` = 掃 TOML + SQLite，返回 due automations
- `cc()` = `t.pr()` = 更新 SQLite next_run_at（從不被執行）
- `Ln()` = Scheduler，`setInterval` 每30秒，startup 即時觸發
- `zn()` / `Bn()` = 實際執行 automation

**已排除：**
- TOML schema 驗證失敗
- SQLite camelCase 映射問題
- AppServerConnection 斷線（stdio hostId=local 正常連接）
- getConnection 拋錯

**最可能原因：**
```
Codex 有 com.apple.security.app-sandbox = true
→ macOS 沙盒可能阻止讀取 ~/.codex/automations
→ Is() 函數 try-catch 靜默返回 []
→ sc() 返回空數組
→ Scheduler tick 空跑，零日誌，零 SQLite 更新
```

---

## 2026-05-21 Session 2 新發現

- SQLite **完整**，11 條記錄，prompt 全部有內容（3595–3596 chars）
- Backup 同現在一致，**冇記錄被刪**
- Codex UI 顯示「記錄消失」= app 讀唔到 SQLite，唔係真正刪除
- TOML 檔案全部存在（clawbook2 無 TOML，亦無 SQLite entry，係未完成設定）
- Claude 雲端 routines 已喺 claude.ai 設定：5 個（3:00、7:30、12:00、15:30、22:30），今日 3/5 used

## Blocker & Next Actions

**優先做（新 session）：**

1. **系統設定 → 私隱與安全性 → 完整磁碟存取** → 確認 Codex 有冇被拒絕（最可能根因）
2. 如果有權限：**Codex UI → Automations → 每個 PAUSE 再 RESUME**（toggle 強制重設）
3. 如仍無效，直接 reset next_run_at：
   ```bash
   sqlite3 ~/.codex/sqlite/codex-dev.db \
     "UPDATE automations SET next_run_at=$(date +%s)000 WHERE status='ACTIVE';"
   ```
4. 修正 clawbook-1900 corrupted time（目前 next_run_at = 2026-05-21 08:17，應是 19:30）：
   ```bash
   # 今日 19:30 HKT = UTC 11:30 = epoch seconds
   sqlite3 ~/.codex/sqlite/codex-dev.db \
     "UPDATE automations SET next_run_at=strftime('%s','now','start of day','+11 hours','+30 minutes')*1000 WHERE id='clawbook-1900';"
   ```

---

## 重要限制

- **Antigravity 未加入任何 automation prompt** — 等 Penny 自己設定成功後先加
- Clawbook `socialSeed.ts` 已有 Antigravity profile，但 automation 唔涉及

---

## Context Management Rules（本 session 訂立）
1. 讀大檔案前先說明原因
2. 用 grep / snippet，唔整個檔案 paste
3. 每個 major step 後更新呢個 CONTEXT_HANDOFF.md
4. 唔重讀已總結嘅檔案
5. 保持 final answers concise
