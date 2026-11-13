// ============================================================================
// autopost-kit — 排程發文佇列
// ----------------------------------------------------------------------------
// 管「什麼時候發、發了沒、失敗怎麼辦」，不管「怎麼發」。
//   - 時間：絕對時間 / +N 分鐘 / 今天幾點 / 下一個空的固定時段
//   - 不重發：送出前先佔位（publishing），同一筆同時只會有一個送出動作
//   - 中斷復原：送到一半程序被關掉的，標成失敗交給人確認，不自動重送
//   - 暫停：手動暫停，或連續失敗 N 次自動暫停，免得半夜整批燒光
//   - 整批重排：改了時段後把所有排程中的重新分配
// 儲存（store）與實際發文（publish）都由外面注入。
// 零依賴（node 內建）。factory pattern。
// ============================================================================

'use strict';

const SENDABLE = ['draft', 'scheduled', 'failed'];
const DEFAULT_SLOTS = ['11:00', '18:00', '20:00'];
const MINUTE = 60_000;
const SLOT_SEARCH_DAYS = 366;

class AutopostError extends Error {
  // code: not_found | bad_state | bad_time | no_slots ；status: 對應的 HTTP 狀態碼建議值
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AutopostError';
    this.code = code;
    this.status = status;
  }
}

function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return { h, m, label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}

function normalizeSlots(list) {
  if (!Array.isArray(list)) throw new TypeError('autopost-kit: slots 必須是 ["HH:MM", ...] 陣列');
  const parsed = list.map((text) => {
    const clock = parseClock(text);
    if (!clock) throw new TypeError(`autopost-kit: 時段格式不正確：${text}（要 HH:MM）`);
    return clock;
  });
  const unique = [...new Map(parsed.map((clock) => [clock.label, clock])).values()];
  return unique.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
}

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`autopost-kit: ${name} 必須是正整數`);
  return value;
}

function memoryState() {
  let saved = null;
  return { load: () => saved, save: (next) => { saved = next; } };
}

function createAutopost(opts = {}) {
  const { store, publish } = opts;
  if (!store || ['list', 'get', 'update'].some((fn) => typeof store[fn] !== 'function')) {
    throw new TypeError('autopost-kit: 需要 store（list / get / update）');
  }
  if (typeof publish !== 'function') throw new TypeError('autopost-kit: 需要 publish(item) 函式');

  const now = opts.now || (() => new Date());
  const slots = normalizeSlots(opts.slots === undefined ? DEFAULT_SLOTS : opts.slots);
  const slotCapacity = positiveInt(opts.slotCapacity, 1, 'slotCapacity');
  const intervalMs = positiveInt(opts.intervalMs, 30_000, 'intervalMs');
  const autoPauseAfter = opts.autoPauseAfter === undefined ? 3 : opts.autoPauseAfter;
  const maxLateMinutes = opts.maxLateMinutes === undefined ? null : opts.maxLateMinutes;
  const stateStore = opts.state || memoryState();
  if (!Number.isInteger(autoPauseAfter) || autoPauseAfter < 0) {
    throw new TypeError('autopost-kit: autoPauseAfter 必須是 0（關閉）或正整數');
  }

  const inFlight = new Set();
  let timer = null;
  let ticking = false;

  function emit(type, detail) {
    if (typeof opts.onEvent !== 'function') return;
    try {
      opts.onEvent({ type, ...detail });
    } catch {
      // 監聽者的錯不該影響發文
    }
  }

  // ── 時區：時段是「牆上時間」。沒指定 utcOffsetMinutes 就用執行環境的時區 ──────────
  const offsetAt = (date) =>
    opts.utcOffsetMinutes === undefined ? -date.getTimezoneOffset() : opts.utcOffsetMinutes;

  function wallDay(date) {
    const shifted = new Date(date.getTime() + offsetAt(date) * MINUTE);
    return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() };
  }

  function fromWall(y, mo, d, h, m) {
    const guess = Date.UTC(y, mo, d, h, m);
    return new Date(guess - offsetAt(new Date(guess)) * MINUTE);
  }

  // ── 狀態（暫停、連續失敗次數）────────────────────────────────────────────
  async function loadState() {
    const saved = await stateStore.load();
    return { paused: false, reason: '', pausedAt: null, consecutiveFailures: 0, ...(saved || {}) };
  }

  async function saveState(changes) {
    const next = { ...(await loadState()), ...changes };
    await stateStore.save(next);
    return next;
  }

  // ── 時段 ────────────────────────────────────────────────────────────────
  function occupancy(items, { excludeId, statuses = ['scheduled', 'publishing'] } = {}) {
    const counts = new Map();
    for (const item of items) {
      if (item.id === excludeId || !statuses.includes(item.status) || !item.scheduledAt) continue;
      const time = new Date(item.scheduledAt);
      if (Number.isNaN(time.getTime())) continue;
      const key = time.toISOString();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function* slotsAfter(after) {
    const day = wallDay(after);
    for (let offset = 0; offset <= SLOT_SEARCH_DAYS; offset += 1) {
      for (const slot of slots) {
        const candidate = fromWall(day.y, day.mo, day.d + offset, slot.h, slot.m);
        if (candidate.getTime() > after.getTime()) yield candidate;
      }
    }
  }

  function nextFreeSlot(after, counts) {
    if (slots.length === 0) throw new AutopostError('no_slots', '還沒設定發文時段');
    for (const candidate of slotsAfter(after)) {
      if ((counts.get(candidate.toISOString()) || 0) < slotCapacity) return candidate;
    }
    throw new AutopostError('no_slots', '一年內的時段都排滿了');
  }

  // ── 把各種「什麼時候」換成一個確定的時間 ─────────────────────────────────
  async function resolveTime(when, { excludeId } = {}) {
    const current = now();
    let date;

    if (when instanceof Date || typeof when === 'string') {
      date = new Date(when);
    } else if (when && typeof when === 'object' && when.inMinutes !== undefined) {
      if (typeof when.inMinutes !== 'number' || !Number.isFinite(when.inMinutes) || when.inMinutes <= 0) {
        throw new AutopostError('bad_time', '延後的分鐘數必須大於 0');
      }
      date = new Date(current.getTime() + when.inMinutes * MINUTE);
    } else if (when && typeof when === 'object' && when.slot === 'next') {
      return nextFreeSlot(current, occupancy(await store.list(), { excludeId }));
    } else if (when && typeof when === 'object' && when.at !== undefined) {
      const clock = parseClock(when.at);
      if (!clock) throw new AutopostError('bad_time', '時間格式不正確（要 HH:MM）');
      if (when.day !== undefined) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(when.day));
        if (!match) throw new AutopostError('bad_time', '日期格式不正確（要 YYYY-MM-DD）');
        date = fromWall(Number(match[1]), Number(match[2]) - 1, Number(match[3]), clock.h, clock.m);
      } else {
        // 沒指定哪一天：今天那個時間還沒到就今天，過了就明天
        const day = wallDay(current);
        date = fromWall(day.y, day.mo, day.d, clock.h, clock.m);
        if (date.getTime() <= current.getTime()) date = fromWall(day.y, day.mo, day.d + 1, clock.h, clock.m);
      }
    } else {
      throw new AutopostError('bad_time', '請指定排程時間');
    }

    if (Number.isNaN(date.getTime())) throw new AutopostError('bad_time', '排程時間格式不正確');
    if (date.getTime() <= current.getTime()) throw new AutopostError('bad_time', '排程時間必須在未來');
    return date;
  }

  async function mustGet(id) {
    const item = await store.get(id);
    if (!item) throw new AutopostError('not_found', '找不到這筆項目', 404);
    return item;
  }

  function mustBeChangeable(item, action) {
    if (inFlight.has(item.id) || !SENDABLE.includes(item.status)) {
      throw new AutopostError('bad_state', `這筆目前是「${item.status}」狀態，不能${action}`, 409);
    }
  }

  // ── 排程 ────────────────────────────────────────────────────────────────
  async function schedule(id, when) {
    const item = await mustGet(id);
    mustBeChangeable(item, '排程');
    const date = await resolveTime(when, { excludeId: id });
    return store.update(id, { status: 'scheduled', scheduledAt: date.toISOString(), error: null });
  }

  async function unschedule(id) {
    const item = await mustGet(id);
    mustBeChangeable(item, '取消排程');
    return store.update(id, { status: 'draft', scheduledAt: null, error: null });
  }

  // 把所有排程中的項目，照原本的先後順序重新填進時段（改了時段設定之後用）
  async function reschedulePending({ from } = {}) {
    const items = await store.list();
    const pending = items
      .filter((item) => item.status === 'scheduled' && !inFlight.has(item.id))
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    const counts = occupancy(items, { statuses: ['publishing'] });
    const start = from ? new Date(from) : now();
    const updated = [];
    for (const item of pending) {
      const slot = nextFreeSlot(start, counts);
      const key = slot.toISOString();
      counts.set(key, (counts.get(key) || 0) + 1);
      updated.push(await store.update(item.id, { scheduledAt: key }));
    }
    return updated;
  }

  async function upcomingSlots(count = 6) {
    if (slots.length === 0) return [];
    const counts = occupancy(await store.list());
    const result = [];
    for (const candidate of slotsAfter(now())) {
      const taken = counts.get(candidate.toISOString()) || 0;
      result.push({ at: candidate.toISOString(), taken, free: taken < slotCapacity });
      if (result.length >= count) break;
    }
    return result;
  }

  // ── 發布 ────────────────────────────────────────────────────────────────
  async function recordFailure(item) {
    const state = await loadState();
    const consecutiveFailures = state.consecutiveFailures + 1;
    const shouldPause = autoPauseAfter > 0 && consecutiveFailures >= autoPauseAfter && !state.paused;
    if (!shouldPause) {
      await saveState({ consecutiveFailures });
      return;
    }
    const reason = `連續 ${consecutiveFailures} 次發布失敗，已自動暫停排程`;
    await saveState({ consecutiveFailures, paused: true, reason, pausedAt: now().toISOString() });
    emit('paused', { reason, item });
  }

  async function publishNow(id) {
    // 同步檢查 + 佔位：兩個呼叫同時進來，第二個在任何 await 之前就被擋掉
    if (inFlight.has(id)) throw new AutopostError('bad_state', '這筆正在發布中', 409);
    inFlight.add(id);
    try {
      const item = await mustGet(id);
      if (!SENDABLE.includes(item.status)) {
        throw new AutopostError('bad_state', `這筆目前是「${item.status}」狀態，不能發布`, 409);
      }
      const attempts = (item.attempts || 0) + 1;
      const claimed = await store.update(id, { status: 'publishing', error: null });

      let result;
      try {
        result = await publish(claimed);
      } catch (error) {
        const message = (error && error.message) || String(error);
        const failed = await store.update(id, { status: 'failed', error: message, attempts });
        emit('failed', { item: failed, error });
        await recordFailure(failed);
        return failed;
      }

      const done = await store.update(id, {
        status: 'published',
        publishedAt: now().toISOString(),
        resultUrl: (result && result.url) || null,
        error: null,
        attempts,
      });
      await saveState({ consecutiveFailures: 0 });
      emit('published', { item: done });
      return done;
    } finally {
      inFlight.delete(id);
    }
  }

  // 上次程序在送出途中被關掉的：不知道有沒有送成功，不自動重送
  async function recoverInterrupted() {
    const stuck = (await store.list()).filter((item) => item.status === 'publishing' && !inFlight.has(item.id));
    const recovered = [];
    for (const item of stuck) {
      recovered.push(
        await store.update(item.id, {
          status: 'failed',
          error: '發布途中服務被中斷，請先確認是否已發出，再決定要不要重發',
        }),
      );
    }
    return recovered;
  }

  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      if ((await loadState()).paused) return [];
      const current = now();
      const due = (await store.list())
        .filter((item) => item.status === 'scheduled' && item.scheduledAt && new Date(item.scheduledAt) <= current)
        .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));

      const results = [];
      for (const item of due) {
        if ((await loadState()).paused) break; // 這一輪中途觸發自動暫停，後面的先不送
        const lateMinutes = (current.getTime() - new Date(item.scheduledAt).getTime()) / MINUTE;
        try {
          if (maxLateMinutes !== null && lateMinutes > maxLateMinutes) {
            results.push(
              await store.update(item.id, {
                status: 'failed',
                error: `錯過排程時間超過 ${maxLateMinutes} 分鐘（當時服務沒在跑），沒有自動補發`,
              }),
            );
            continue;
          }
          results.push(await publishNow(item.id));
        } catch (error) {
          emit('error', { item, error });
        }
      }
      return results;
    } finally {
      ticking = false;
    }
  }

  // ── 暫停 ────────────────────────────────────────────────────────────────
  async function pause(reason = '手動暫停') {
    await saveState({ paused: true, reason: String(reason), pausedAt: now().toISOString() });
    return status();
  }

  async function resume() {
    await saveState({ paused: false, reason: '', pausedAt: null, consecutiveFailures: 0 });
    return status();
  }

  async function status() {
    const state = await loadState();
    return { ...state, slots: slots.map((slot) => slot.label), slotCapacity, running: timer !== null };
  }

  const reportError = (error) => emit('error', { error });

  return {
    schedule,
    unschedule,
    reschedulePending,
    resolveTime,
    upcomingSlots,
    publishNow,
    recoverInterrupted,
    tick,
    pause,
    resume,
    status,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch(reportError), intervalMs);
      recoverInterrupted().then(tick).catch(reportError);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = createAutopost;
module.exports.createAutopost = createAutopost;
module.exports.AutopostError = AutopostError;
