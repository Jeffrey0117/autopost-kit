'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const createAutopost = require('../index');
const { AutopostError } = createAutopost;

// 台北時間 2026-11-13 10:00（= 02:00Z），時段固定用 +08:00 算，測試不受執行環境時區影響
const START = Date.parse('2026-11-13T02:00:00Z');
const TAIPEI = 480;

function setup(overrides = {}) {
  let clock = START;
  let items = [];
  let saved = null;
  const sent = [];
  const events = [];

  const store = {
    list: () => items.map((item) => ({ ...item })),
    get: (id) => {
      const found = items.find((item) => item.id === id);
      return found ? { ...found } : null;
    },
    update: (id, changes) => {
      items = items.map((item) => (item.id === id ? { ...item, ...changes } : item));
      return store.get(id);
    },
  };
  const add = (id, fields = {}) => {
    items = [...items, { id, status: 'draft', scheduledAt: null, ...fields }];
    return id;
  };

  const queue = createAutopost({
    store,
    publish: async (item) => {
      if (item.fail) throw new Error('站方拒絕');
      sent.push(item.id);
      return { url: `https://example.test/${item.id}` };
    },
    now: () => new Date(clock),
    utcOffsetMinutes: TAIPEI,
    state: { load: () => saved, save: (next) => { saved = next; } },
    onEvent: (event) => events.push(event.type),
    ...overrides,
  });

  return {
    queue,
    store,
    add,
    sent,
    events,
    advance: (minutes) => { clock += minutes * 60_000; },
    savedState: () => saved,
  };
}

test('schedule accepts an absolute time, a delay, and a clock time', async () => {
  const { queue, add } = setup();
  add('a'); add('b'); add('c'); add('d');

  assert.equal((await queue.schedule('a', '2026-11-20T01:00:00Z')).scheduledAt, '2026-11-20T01:00:00.000Z');
  assert.equal((await queue.schedule('b', { inMinutes: 30 })).scheduledAt, '2026-11-13T02:30:00.000Z');
  // 現在是台北 10:00：18:00 還沒到 → 今天；09:00 已過 → 明天
  assert.equal((await queue.schedule('c', { at: '18:00' })).scheduledAt, '2026-11-13T10:00:00.000Z');
  assert.equal((await queue.schedule('d', { at: '09:00' })).scheduledAt, '2026-11-14T01:00:00.000Z');
  assert.equal((await queue.schedule('d', { at: '09:00', day: '2026-12-01' })).scheduledAt, '2026-12-01T01:00:00.000Z');
});

test('next slot takes the first free slot and rolls over to the next day', async () => {
  const { queue, add } = setup({ slots: ['20:00', '11:00', '18:00'] });
  ['a', 'b', 'c', 'd'].forEach((id) => add(id));

  const times = [];
  for (const id of ['a', 'b', 'c', 'd']) times.push((await queue.schedule(id, { slot: 'next' })).scheduledAt);
  assert.deepEqual(times, [
    '2026-11-13T03:00:00.000Z', // 今天 11:00
    '2026-11-13T10:00:00.000Z', // 今天 18:00
    '2026-11-13T12:00:00.000Z', // 今天 20:00
    '2026-11-14T03:00:00.000Z', // 明天 11:00
  ]);

  // 重排自己時不會被自己佔住的那格擋到
  assert.equal((await queue.schedule('a', { slot: 'next' })).scheduledAt, '2026-11-13T03:00:00.000Z');
});

test('slotCapacity lets several items share a slot', async () => {
  const { queue, add } = setup({ slots: ['11:00'], slotCapacity: 2 });
  ['a', 'b', 'c'].forEach((id) => add(id));
  const times = [];
  for (const id of ['a', 'b', 'c']) times.push((await queue.schedule(id, { slot: 'next' })).scheduledAt);
  assert.deepEqual(times, ['2026-11-13T03:00:00.000Z', '2026-11-13T03:00:00.000Z', '2026-11-14T03:00:00.000Z']);
});

test('rejects times that are past, malformed, or missing', async () => {
  const { queue, add, store } = setup();
  add('a');
  const bad = ['2026-11-13T01:00:00Z', 'not-a-date', null, {}, { inMinutes: 0 }, { inMinutes: 'x' }, { at: '25:00' },
    { at: '09:00', day: '2026-11-13' }, { at: '09:00', day: 'tomorrow' }];
  for (const when of bad) {
    await assert.rejects(queue.schedule('a', when), (error) => error instanceof AutopostError && error.code === 'bad_time');
  }
  assert.equal(store.get('a').status, 'draft');
  await assert.rejects(queue.schedule('missing', { inMinutes: 5 }), (error) => error.status === 404);
});

test('tick sends only what is due, in order, exactly once', async () => {
  const { queue, add, sent, advance, store } = setup();
  add('late'); add('soon'); add('draft');
  await queue.schedule('late', { inMinutes: 60 });
  await queue.schedule('soon', { inMinutes: 10 });

  assert.deepEqual(await queue.tick(), []);
  advance(11);
  await queue.tick();
  await queue.tick();
  assert.deepEqual(sent, ['soon']);
  assert.equal(store.get('soon').status, 'published');
  assert.equal(store.get('soon').resultUrl, 'https://example.test/soon');
  assert.equal(store.get('soon').attempts, 1);
  assert.equal(store.get('late').status, 'scheduled');
  assert.equal(store.get('draft').status, 'draft');
});

test('two simultaneous publishNow calls send once', async () => {
  const { queue, add, sent } = setup();
  add('a');
  const results = await Promise.allSettled([queue.publishNow('a'), queue.publishNow('a')]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(sent.length, 1);
  await assert.rejects(queue.publishNow('a'), (error) => error.status === 409); // 已發布的不能再發
});

test('a failure is recorded and the item can be rescheduled or resent', async () => {
  const { queue, add, store, sent } = setup();
  add('a', { fail: true });
  const failed = await queue.publishNow('a');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '站方拒絕');
  assert.equal(failed.attempts, 1);

  store.update('a', { fail: false });
  assert.equal((await queue.schedule('a', { inMinutes: 5 })).status, 'scheduled');
  assert.equal((await queue.publishNow('a')).status, 'published');
  assert.deepEqual(sent, ['a']);
});

test('auto-pauses after consecutive failures and holds the rest until resumed', async () => {
  const { queue, add, store, sent, advance, events, savedState } = setup({ autoPauseAfter: 3 });
  ['f1', 'f2', 'f3'].forEach((id) => add(id, { fail: true }));
  add('ok');
  let minutes = 1;
  for (const id of ['f1', 'f2', 'f3', 'ok']) await queue.schedule(id, { inMinutes: minutes++ });

  advance(10);
  await queue.tick();
  const status = await queue.status();
  assert.equal(status.paused, true);
  assert.match(status.reason, /連續 3 次/);
  assert.equal(store.get('ok').status, 'scheduled'); // 第三次失敗後這一輪就停手
  assert.ok(events.includes('paused'));
  assert.equal(savedState().paused, true); // 暫停狀態有寫進注入的 state

  await queue.tick();
  assert.deepEqual(sent, []);

  await queue.resume();
  await queue.tick();
  assert.deepEqual(sent, ['ok']);
  assert.equal((await queue.status()).consecutiveFailures, 0);
});

test('a success in between resets the failure streak', async () => {
  const { queue, add } = setup({ autoPauseAfter: 2 });
  add('f1', { fail: true }); add('ok'); add('f2', { fail: true });
  await queue.publishNow('f1');
  await queue.publishNow('ok');
  await queue.publishNow('f2');
  assert.equal((await queue.status()).paused, false);
});

test('manual pause holds scheduled sends but not an explicit publishNow', async () => {
  const { queue, add, sent, advance } = setup();
  add('a'); add('b');
  await queue.schedule('a', { inMinutes: 1 });
  await queue.pause('出門');
  advance(5);
  assert.deepEqual(await queue.tick(), []);
  assert.equal((await queue.status()).reason, '出門');
  await queue.publishNow('b');
  assert.deepEqual(sent, ['b']);
});

test('items interrupted mid-send are marked failed, not resent', async () => {
  const { queue, add, store, sent } = setup();
  add('a', { status: 'publishing' });
  const recovered = await queue.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(store.get('a').status, 'failed');
  assert.match(store.get('a').error, /中斷/);
  await queue.tick();
  assert.deepEqual(sent, []);
});

test('reschedulePending refills slots in the original order', async () => {
  const { queue, add, store } = setup({ slots: ['12:00', '21:00'] });
  add('a'); add('b'); add('c'); add('draft');
  await queue.schedule('c', '2026-11-13T05:00:00Z');
  await queue.schedule('a', '2026-11-20T05:00:00Z');
  await queue.schedule('b', '2026-11-25T05:00:00Z');

  const updated = await queue.reschedulePending();
  assert.deepEqual(updated.map((item) => [item.id, item.scheduledAt]), [
    ['c', '2026-11-13T04:00:00.000Z'], // 今天 12:00
    ['a', '2026-11-13T13:00:00.000Z'], // 今天 21:00
    ['b', '2026-11-14T04:00:00.000Z'], // 明天 12:00
  ]);
  assert.equal(store.get('draft').status, 'draft');
});

test('maxLateMinutes refuses to send something that missed its time by too much', async () => {
  const { queue, add, store, sent, advance } = setup({ maxLateMinutes: 60 });
  add('a');
  await queue.schedule('a', { inMinutes: 10 });
  advance(10 + 61);
  await queue.tick();
  assert.deepEqual(sent, []);
  assert.equal(store.get('a').status, 'failed');
  assert.match(store.get('a').error, /錯過排程時間/);
});

test('upcomingSlots shows which slots are taken', async () => {
  const { queue, add } = setup();
  add('a');
  await queue.schedule('a', { at: '18:00' });
  const upcoming = await queue.upcomingSlots(3);
  assert.deepEqual(upcoming.map((slot) => [slot.at, slot.free]), [
    ['2026-11-13T03:00:00.000Z', true],
    ['2026-11-13T10:00:00.000Z', false],
    ['2026-11-13T12:00:00.000Z', true],
  ]);
});

test('bad configuration fails at creation, not at send time', () => {
  const store = { list: () => [], get: () => null, update: () => null };
  const publish = async () => ({});
  assert.throws(() => createAutopost({ publish }), /store/);
  assert.throws(() => createAutopost({ store }), /publish/);
  assert.throws(() => createAutopost({ store, publish, slots: ['25:00'] }), /時段格式/);
  assert.throws(() => createAutopost({ store, publish, slotCapacity: 0 }), /slotCapacity/);
  assert.throws(() => createAutopost({ store, publish, autoPauseAfter: -1 }), /autoPauseAfter/);
});

test('with no slots configured, asking for the next slot is a clear error', async () => {
  const { queue, add } = setup({ slots: [] });
  add('a');
  await assert.rejects(queue.schedule('a', { slot: 'next' }), (error) => error.code === 'no_slots');
  assert.deepEqual(await queue.upcomingSlots(), []);
});
