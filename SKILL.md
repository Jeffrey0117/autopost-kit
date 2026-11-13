---
name: autopost-kit
description: 要做「排程發文／定時發布／自動發文佇列」時用——文章、影片、貼文排時間自動送出，含固定時段、+N 分鐘、防重發、失敗暫停。使用者說「排程發文」「定時發」「每天幾點發」「自動發文」就載入，不要自己再寫一個 scheduler。
---

# autopost-kit — 打法

**排程發文佇列：管「什麼時候發、發了沒、失敗怎麼辦」，不管「怎麼發」。儲存與發文函式都注入。**

## 何時觸發

- 專案要「排個時間，到時候自動發出去」：部落格、論壇、IG、影片上架、電子報。
- 看到有人在寫 `setInterval` + `status === 'scheduled' && scheduledAt <= now` 這種迴圈——那就是在重造這個 kit。
- 已經有自製排程但缺東缺西（沒時段、會重發、沒暫停）→ 換成這個，不要補丁。

不適用：單次呼叫失敗要重試幾次（那是 `retry-kit`）；一般的 cron 工作（這個 kit 的單位是「一筆要發的東西」）。

## 接線（照抄能跑）

1. `npm i github:Jeffrey0117/autopost-kit`
2. 資料每筆要有 `id`、`status`（新增時設 `draft`）、`scheduledAt`。其他欄位隨你。
3. 建佇列，啟動：

```js
const createAutopost = require('autopost-kit'); // ESM：import createAutopost from 'autopost-kit'

const queue = createAutopost({
  store,                                   // { list, get, update }，同步或 async 都行
  publish: (post) => platforms[post.platform].publish(post), // 失敗就 throw
  slots: (process.env.POST_SLOTS || '11:00,18:00,20:00').split(','),
  state: { load: readState, save: writeState }, // 一定要給，不然重啟就忘了暫停
  onEvent: (event) => event.type === 'paused' && notify(event.reason),
});
queue.start();
```

4. API 這層只做轉接，錯誤直接用 `AutopostError.status` 回：

```js
app.post('/api/posts/:id/schedule', async (req, res) => {
  try {
    res.json(await queue.schedule(req.params.id, req.body.when));
  } catch (error) {
    if (error instanceof AutopostError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});
```

`when` 直接收前端傳來的：ISO 字串、`{ inMinutes: 30 }`、`{ at: '18:00' }`、`{ at: '18:00', day: '2026-12-01' }`、`{ slot: 'next' }`。kit 會驗證，不用自己再驗一次。

## 模式與文案

**介面上排時間的順序（由快到慢）**——大部分時候使用者不想挑時間，只想「排進去」：

1. 主按鈕：**排進下一個時段**，按鈕上直接寫出會排到什麼時候（用 `upcomingSlots(1)` 或 `resolveTime({ slot: 'next' })`）。
2. 一排快捷鍵：`+10 分`、`+30 分`、`+1 小時`，以及每個固定時段（`11:00`、`18:00`、`20:00`，從 `status().slots` 讀，別寫死）。
3. 最後才是日期時間選擇器。日曆是用來「看排了什麼」的，不是主要輸入。

**暫停要讓人看得到**：`status().paused` 為真時，頁面最上面放一條，寫出 `reason` 和「恢復排程」按鈕。自動暫停時用 `onEvent` 發通知（Telegram 之類），不然沒人知道排程停了。

**失敗的項目**放在清單最上面一區「需要處理」，顯示 `error`，給「重發」和「重新排程」兩個動作。

**文案**：錯誤訊息 kit 已經寫好中文，直接顯示 `error.message`。

## 地雷

- **不要自己改 `status`**。尤其不要自己寫 `status: 'publishing'` 或 `'published'`——佔位、防重發、連續失敗計數都靠 kit 經手。新增時設 `draft`，之後全部走 kit 的方法。（`kit-checks.json` 會抓這條）
- **`state` 沒注入 = 暫停只存在記憶體**。服務一重啟，自動暫停就消失，壞掉的排程又開始整批失敗。
- **`publish` 結果不明時要 throw，不要回成功**。例如送出後沒收到預期的跳轉：寧可標失敗讓人去確認，也不要標成功然後其實沒發；更不要因為「不確定」就自動重送。
- **中斷的不會自動重送**是故意的。`publishing` 狀態卡住代表「不知道有沒有發出去」，重送可能重複發文。
- **時區**：時段用執行環境的時區算。部署到別的時區的機器（VPS 常是 UTC）要明確給 `utcOffsetMinutes: 480`。
- **服務停很久再開**，預設會把過期的全部補發。不想這樣就設 `maxLateMinutes`。
- **多個程序同時跑同一個 store** 不在守備範圍內：防重發的佔位是程序內的。要多機就得在 store 層做原子的 claim。
- **暫停不擋 `publishNow`**：暫停擋的是排程自動送出，使用者明確按「立即發布」照發。
