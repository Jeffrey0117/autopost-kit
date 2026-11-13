// 最小範例：node example.js
// 用記憶體當 store、假的 publish，跑一遍「排進時段 → 時間到 → 發出去 → 連續失敗自動暫停」。
const createAutopost = require('./index');

let clock = Date.parse('2026-11-13T02:00:00Z'); // 台北 10:00
let items = [
  { id: 'a', title: '第一篇', status: 'draft' },
  { id: 'b', title: '第二篇', status: 'draft' },
  { id: 'c', title: '會失敗的', status: 'draft', fail: true },
];

const store = {
  list: () => items,
  get: (id) => items.find((item) => item.id === id) || null,
  update: (id, changes) => {
    items = items.map((item) => (item.id === id ? { ...item, ...changes } : item));
    return store.get(id);
  },
};

const queue = createAutopost({
  store,
  publish: async (item) => {
    if (item.fail) throw new Error('站方拒絕');
    return { url: `https://example.test/${item.id}` };
  },
  slots: ['11:00', '18:00', '20:00'],
  autoPauseAfter: 1,
  utcOffsetMinutes: 480,
  now: () => new Date(clock),
  onEvent: (event) => console.log(`  [event] ${event.type}${event.reason ? `：${event.reason}` : ''}`),
});

const show = (label) =>
  console.log(label, items.map((item) => `${item.title}=${item.status}${item.scheduledAt ? `@${item.scheduledAt.slice(5, 16)}Z` : ''}`).join('  '));

(async () => {
  await queue.schedule('a', { slot: 'next' }); // 今天 11:00
  await queue.schedule('b', { inMinutes: 30 }); // 30 分鐘後
  await queue.schedule('c', { at: '18:00' }); // 今天 18:00
  show('排好：');

  clock += 90 * 60_000; // 過 90 分鐘
  await queue.tick();
  show('90 分鐘後：');

  clock += 8 * 60 * 60_000; // 再過 8 小時，c 到期並失敗 → 自動暫停
  await queue.tick();
  show('18:00 之後：');
  console.log('狀態：', await queue.status());
})();
