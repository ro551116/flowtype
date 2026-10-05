# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

活動流程表（Cue Sheet）系統 — 用於活動現場技術人員的流程管理工具。支援多場活動、自訂角色組別、自訂欄位、流程表編輯、封存、版本紀錄、線上預覽（`/v/:id`），以及 PDF 匯出（完整版／流程大表／Cue 表，含中文字型）。

## 開發指令

```bash
npm start              # 啟動伺服器（預設 port 3000）
npm test               # node:test 後端回歸測試（test/）

# Docker
docker build -t cue-sheet .
docker run -p 3000:3000 -v $(pwd)/data:/data cue-sheet
```

環境變數：

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data`（Docker：`/data`） | 活動 JSON；`_archived/` 為封存活動 |
| `BACKUP_DIR` | `$DATA_DIR/_backups` | 版本紀錄；必須和 `DATA_DIR` 在同一個持久磁碟，否則重新部署就會清空 |

## 架構

**單體應用**：Express 後端 + 純前端（無框架、無建構工具）。

- `server.js` — Express API 與靜態檔案。資料以 JSON 檔存在 `DATA_DIR`，無資料庫。匯出 `app` 供測試使用；直接執行才 listen。
- `public/index.html` — 編輯器（HTML + CSS + JS 合一）：活動列表頁／編輯頁兩頁式 SPA、自動儲存、復原、版本紀錄、PDF 匯出（jsPDF + autotable，CDN）。
- `public/view.html` — 唯讀線上預覽，每 3 秒輪詢更新。
- `public/fonts/NotoSansTC-Regular.ttf` — PDF 中文字型。
- `test/server.test.js` — 後端行為測試（路徑驗證、備份、衝突偵測、封存）。

### API 端點

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/events` | 列出活動；`?archived=true` 列出封存 |
| GET | `/api/events/:id` | 取得活動（含封存）；回應帶 `_archived` 與 `ETag`（版本） |
| POST | `/api/events` | 建立活動；空 body 會建立空白範本 |
| PUT | `/api/events/:id` | 原地更新（封存中的活動留在封存區）。帶 `If-Match` 時版本不符回 `412` |
| DELETE | `/api/events/:id` | 刪除（含封存） |
| POST | `/api/events/:id/duplicate` | 複製（含封存活動；副本為進行中） |
| POST | `/api/events/:id/archive` | 封存 |
| POST | `/api/events/:id/unarchive` | 取消封存 |
| POST | `/api/events/archive-expired` | 封存日期早於今天（台灣時間）的活動 |
| GET | `/api/events/:id/backups` | 列出版本紀錄 |
| POST | `/api/events/:id/restore/:filename` | 回復到該活動自己的某個備份（目前版本先備份） |
| GET | `/v/:id` | 線上預覽頁 |

`:id` 只接受 `[A-Za-z0-9_-]{1,64}`，其他一律 `400`（防止路徑穿越）。

### 儲存與版本規則

- 寫檔一律「先寫暫存檔再 rename」，避免寫到一半損毀。
- `PUT` 帶 `If-Match`（編輯器自動儲存）：版本相符才寫入；被覆蓋的版本每 5 分鐘最多留一份備份。
- `PUT` 不帶 `If-Match` 或帶 `*`（`flowtype-cli update`、使用者選擇覆蓋衝突）：無條件寫入，被覆蓋的版本一定備份。
- 每個活動最多保留 30 份備份。
- `_archived` 等底線開頭的回應欄位不會寫進檔案。

### 資料結構（JSON）

```json
{
  "event": { "name", "date", "venue", "organizer", "contact", "phone" },
  "roles": ["場控", "音控", "燈控", "視訊"],
  "customFields": [{ "label": "", "value": "" }],
  "rows": [
    { "time", "duration", "item", "notes": { "場控": "" }, "isSection": false, "isInstruction": false },
    { "isSection": true, "sectionLabel": "" },
    { "isInstruction": true, "instructionText": "" }
  ]
}
```

`event.date` 通常是 `YYYY-MM-DD`；Excel 匯入可能是自由文字（例 `2026/4/9（四）14:00`），編輯器在使用者沒改日期時會保留原文。

## 注意事項

- 前端無模組化，函式為全域。修改 JS 需編輯 HTML 內的 `<script>`。
- 使用者資料寫進 `innerHTML` 一律經過 `esc()`；inline handler 不可嵌入使用者文字，改用 `data-*` 屬性再從 `this.dataset` 讀取。
- 編輯器儲存流程：`autoSave()` 延遲 800ms → `saveNow()` 串行送出 PUT（帶 `If-Match`）→ 失敗時狀態顯示 `SAVE FAILED` 並每 5 秒重試；離開編輯頁前會先送出未儲存的修改。
- UI 文字對比至少 4.5:1：文字與實心按鈕用 `--accent-strong`（`--accent` 只給邊框、logo 等裝飾）；`--text-muted` 已調到可讀。角色配色在 `ROLE_COLORS`／`PDF_ROLE_COLORS`／`view.html` 的 `.rc-*` 三處，要一起改。最小字級 12px。
- 流程表重繪後呼叫 `autoGrowAll()`，讓 textarea 依內容長高；欄寬靠 `.cell-*` 的 `min-width` 撐住，窄螢幕改成整張表橫向捲動。
- 觸控裝置（`hover: none`）上，列操作與卡片操作按鈕一律顯示；`pointer: coarse` 時按鈕至少 40–44px。
- PDF 欄寬：時間／時長用 `fitColumnWidth()` 依實際文字量寬度，項目與角色欄用 `distributeWidths()` 依內容分配；表格設 `rowPageBreak: 'avoid'`，一列不跨頁。
- PDF 中文顯示仰賴 `public/fonts/NotoSansTC-Regular.ttf`，前端載入後 base64 注入 jsPDF。
- `flowtype-cli`（hg-vault `.agent/tools/go/flowtype-cli/`）使用同一組 API，改 API 形狀時要一起確認。
