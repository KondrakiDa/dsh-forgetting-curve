// 时钟抽象。
//
// 为什么要单独抽一层：整个调度都是时间和衰减驱动的，如果引擎里到处写 Date.now()，
// 那"三个月后这条记忆会不会进 dormant"就只能在真实时间里等三个月才能验证。
// 这里的 fake clock 让测试可以在一秒内推演 30 天的对话流。
//
// 约定：引擎**不注册定时器**，只在被调用时按 now() 计算。这是拉模式，
// 所以 fake clock 只需要能改 now() 的返回值就够了，不需要真的驱动 setTimeout。

export function createRealClock() {
  return {
    kind: 'real',
    now: () => Date.now(),
  };
}

/**
 * 可快进的时钟。start 一般传一个固定日期让测试可重现。
 * advance / advanceDays 返回新的时间戳，方便链式断言。
 */
export function createFakeClock(startMs = Date.now()) {
  if (!Number.isFinite(startMs)) throw new Error('createFakeClock: startMs 必须是有限数值');
  let t = startMs;
  const api = {
    kind: 'fake',
    now: () => t,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('advance: 需要非负毫秒');
      t += ms;
      return t;
    },
    advanceDays(d) {
      if (!Number.isFinite(d) || d < 0) throw new Error('advanceDays: 需要非负天数');
      return api.advance(Math.round(d * 86400000));
    },
    /** 直接把时钟拨到某个绝对时间（用于"隔了一天再打开"这类场景）。 */
    set(ms) {
      if (!Number.isFinite(ms)) throw new Error('set: 需要有限数值');
      t = ms;
      return t;
    },
  };
  return api;
}

/** 天 → 毫秒，顺手把 <=0 的脏值钳成极小正数，避免除零。 */
export const DAY_MS = 86400000;
export const MINUTE_MS = 60000;

export function days(ms) {
  return ms / DAY_MS;
}
