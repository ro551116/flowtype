# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

活動流程表（Cue Sheet）系統 — 用於活動現場技術人員的流程管理工具。支援多場活動、自訂角色組別、流程表編輯，以及 PDF 匯出（含中文字型）。

## 開發指令

```bash
# 啟動開發伺服器（預設 port 3000）
npm start              # 或 node server.js

# Docker
docker build -t cue-sheet .
docker run -p 3000:3000 -v $(pwd)/data:/data cue-sheet
```

環境變數：`PORT`（預設 3000）、`DATA_DIR`（預設 ./data）

## 架構

**單體應用**：Express 後端 + 純前端（單一 `index.html`，無框架、無建構工具）。

- `server.js` — Express API 伺服器，提供 REST API 與靜態檔案服務。資料以 JSON 檔案存在 `data/` 目錄，無資料庫。
- `public/index.html` — 全部前端邏輯（HTML + CSS + JS 合一）。包含：
  - 兩頁式 SPA（活動列表頁 / 編輯器頁），用 DOM display 切換
  - 前端 state 物件管理目前編輯的活動資料
  - 自動儲存（debounce 800ms → PUT API）
  - PDF 匯出：使用 jsPDF + jspdf-autotable（CDN），搭配自架 NotoSansTC 中文字型
- `public/fonts/NotoSansTC-Regular.ttf` — 中文字型，PDF 匯出用
- `data/` — 活動 JSON 檔案儲存目錄（git 不追蹤）

### API 端點

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/events` | 列出所有活動 |
| GET | `/api/events/:id` | 取得單一活動 |
| POST | `/api/events` | 建立新活動 |
| PUT | `/api/events/:id` | 更新活動 |
| DELETE | `/api/events/:id` | 刪除活動 |
| POST | `/api/events/:id/duplicate` | 複製活動 |

### 資料結構（JSON）

```json
{
  "event": { "name", "date", "venue", "organizer", "contact", "phone" },
  "roles": ["場控", "音控", "燈控", "視訊"],
  "rows": [
    { "time", "duration", "item", "notes": { "場控": "", ... }, "isSection": false, "sectionLabel": "" }
  ]
}
```

## 注意事項

- 前端無模組化，所有函式為全域。修改 JS 邏輯需編輯 `public/index.html` 內的 `<script>` 區塊。
- PDF 中文顯示仰賴 `public/fonts/NotoSansTC-Regular.ttf`，字型會在前端載入並 base64 編碼後注入 jsPDF。
- 無測試、無 linter、無 TypeScript。
