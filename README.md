# autopost-kit

**排程發文佇列。** 管「什麼時候發、發了沒、失敗怎麼辦」，不管「怎麼發」。零依賴、框架無關，儲存和實際發文都由你注入。

每個自動發文的專案都會重寫一次這塊，而且每次都漏一點：有的沒有固定時段，有的會重發，有的半夜連續失敗把整批燒光。這個 kit 把它們收在一起。

- **排時間的四種說法**：絕對時間、`+N 分鐘`、今天幾點、下一個空的固定時段
- **不重發**：送出前先佔位，同一筆同時只會有一個送出動作
- **中斷復原**：送到一半程序被關掉的，標成失敗交給人確認，不自動重送
- **暫停**：手動暫停，或連續失敗 N 次自動暫停
- **整批重排**：改了時段後，把排程中的全部重新分配

## 安裝

```bash
npm i github:Jeffrey0117/autopost-kit   # 或直接複製 index.js
```

## 用法

```js
const createAutopost = require('autopost-kit');

const queue = createAutopost({
  // 你的資料層。同步或 async 都可以。
  store: {
    list: () => db.allPosts(),
    get: (id) => db.findPost(id),
    update: (id, changes) => db.patchPost(id, changes), // 要回傳更新後的那筆
  },
  // 你的發文函式。成功回 { url }（可省略），失敗就 throw。
  publish: async (post) => platform.send(post),

  slots: ['11:00', '18:00', '20:00'], // 每天的固定時段
  autoPauseAfter: 3,                  // 連續失敗幾次自動暫停，0 = 關閉
  state: {                            // 暫停狀態存哪（不給就只存在記憶體，重啟會忘）
    load: () => readJson('queue-state.json'),
    save: (state) => writeJson('queue-state.json', state),
  },
});

queue.start(); // 開始定時檢查；啟動時會先處理上次中斷的

await queue.schedule(id, { slot: 'next' });               // 下一個空時段
await queue.schedule(id, { inMinutes: 30 });              // 30 分鐘後
await queue.schedule(id, { at: '18:00' });                // 今天 18:00，過了就明天
await queue.schedule(id, { at: '18:00', day: '2026-12-01' });
await queue.schedule(id, '2026-12-01T10:00:00Z');         // 絕對時間（ISO 字串或 Date）
await queue.publishNow(id);                               // 立刻發
```

跑一遍看看：`node example.js`

## 你的資料要有哪些欄位

kit 只讀寫下面這些，其他欄位（標題、內容、平台…）原封不動交給你的 `publish`。

| 欄位 | 說明 |
|---|---|
| `id` | 你自己產生 |
| `status` | `draft` → `scheduled` → `publishing` → `published` 或 `failed` |
| `scheduledAt` | ISO 時間字串，或 `null` |
| `publishedAt` | 發布成功的時間 |
| `resultUrl` | `publish` 回傳的 `url` |
| `error` | 失敗原因 |
| `attempts` | 送出過幾次 |

新增一筆時自己把 `status` 設成 `draft`，之後的狀態都交給 kit 改。

## API

| 方法 | 做什麼 |
|---|---|
| `schedule(id, when)` | 排程。草稿、已排程、失敗的都可以排 |
| `unschedule(id)` | 取消排程，退回草稿 |
| `publishNow(id)` | 立刻發。暫停中也照發（那是你明確按的） |
| `tick()` | 發出所有到期的。`start()` 會定時呼叫，你也可以自己接 cron |
| `start()` / `stop()` | 開關定時檢查 |
| `pause(reason)` / `resume()` | 暫停／恢復排程。`resume` 會把連續失敗次數歸零 |
| `status()` | `{ paused, reason, pausedAt, consecutiveFailures, slots, slotCapacity, running }` |
| `upcomingSlots(n)` | 接下來 n 個時段與是否已被佔：`[{ at, taken, free }]`，給介面顯示用 |
| `resolveTime(when)` | 只算時間不排程，給介面預覽「會排到什麼時候」 |
| `reschedulePending({ from })` | 把所有排程中的照原順序重新填進時段 |
| `recoverInterrupted()` | 把卡在 `publishing` 的標成失敗。`start()` 會自動做 |

失敗時丟 `AutopostError`，帶 `code`（`not_found` / `bad_state` / `bad_time` / `no_slots`）和可以直接當 HTTP 狀態碼的 `status`。

```js
const { AutopostError } = require('autopost-kit');
try {
  await queue.schedule(id, body.when);
} catch (error) {
  if (error instanceof AutopostError) return res.status(error.status).json({ error: error.message });
  throw error;
}
```

## 選項

| 選項 | 預設 | 說明 |
|---|---|---|
| `store` | 必填 | `list()` / `get(id)` / `update(id, changes)` |
| `publish` | 必填 | `async (item) => ({ url })`，失敗就 throw |
| `slots` | `['11:00','18:00','20:00']` | 每天的固定時段，`[]` 表示不用時段 |
| `slotCapacity` | `1` | 同一個時段最多幾筆 |
| `autoPauseAfter` | `3` | 連續失敗幾次自動暫停，`0` 關閉 |
| `maxLateMinutes` | `null` | 錯過排程超過這麼久就不補發、標成失敗。`null` = 一律補發 |
| `intervalMs` | `30000` | 多久檢查一次 |
| `utcOffsetMinutes` | 執行環境時區 | 時段用哪個時區算。台北是 `480` |
| `state` | 記憶體 | `{ load(), save(state) }`，存暫停狀態 |
| `now` | `() => new Date()` | 測試時注入假時鐘 |
| `onEvent` | — | `({ type, item, error, reason })`，`type` 是 `published` / `failed` / `paused` / `error` |

## 測試

```bash
npm test
```

## License

MIT © Jeffrey0117
