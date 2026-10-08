/**
 * 运行时自检：在 Node 里搭最小浏览器环境直接运行 index.html 中的游戏脚本。
 *
 * 两套观测手段配合使用：
 *   1) 反解绘制调用（fillText / arc）—— 验证"玩家真的看到了什么"，跨版本最稳；
 *   2) index.html 暴露的 window.__SpaceLine 钩子 —— 直接断言内部状态
 *      （连击倍率、震动时长、道具计时、Boss 血量），比反解像素强得多。
 *
 * 场景通过固定 Math.random 让局面可复现：
 *   A. random=0.5 → 敌人全在画面正中直线下落 → 射击命中 / 得分 / 暂停
 *   B. random=0.05 → 敌人全在左侧且必为精英 → 精英分支 / 漏怪扣命 / 结束 / 重开
 *   C. random=0.5 → 震动与连击倍率（回归"CFG.SHAKE_* 缺失导致震动永久失效"）
 *   D. random=0.3 → 道具掉落 / 磁吸拾取 / 五种效果 / 护盾破盾
 *   E. random=0.5 → 冲刺（位移、无敌、冷却）
 *   F. random=0.5 → BOSS 召唤 / 开火 / 敌弹扣命 / 击破结算
 *   G. random=0.5 → 清屏炸弹
 *   H. coarse=1  → 触屏/鼠标相对拖动、多指保护、自动开火、屏幕冲刺按钮
 *   I. random=0.5 → 多武器系统（双列 / 激光解锁切换、激光按 dt 结算伤害、穿透）
 *   J. random=0.5 → BOSS 三阶段（阈值、扇形弹数、狂暴环形弹幕、阶段清弹）
 *   K. store 预置 → 本地排行榜 Top5（排序 / 截断 / 名次 / 旧存档迁移 / 脏数据清洗）
 *   L. random=0.5 → 二倍速模式（档位切换 / 时间真的翻倍 / 步长仍被夹紧 /
 *                    HUD 角标 / 榜单 ×2 标记 / 真实存活计时 / 触屏按钮 / HUD 让位高度）
 *   M. random=0.5 → AI 自动模式（开关 / 自动开火 / 主动躲弹（带对照组）/
 *                    手动夺回 / 换枪滞后 / HUD 角标 / 榜单 AI 标记 / 档位跨局保留）
 *   N. coarse=1  → AI 的触屏入口（圆钮开关、文字与点亮状态、布局桩覆盖率）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/**
 * 搭建一套干净的浏览器环境并执行游戏脚本。
 * @param {number} randomValue 固定后的 Math.random 返回值
 * @param {{coarse?:boolean, touchPoints?:number, store?:object}} [opts]
 *        coarse/touchPoints 用来伪装成触摸设备；store 用来预置 localStorage
 */
function createEnv(randomValue, opts = {}) {
  const fillTexts = [];
  const arcRadii = [];
  const ctxStub = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (prop === 'fillText') return (t) => { fillTexts.push(String(t)); };
      if (prop === 'arc') return (x, y, r) => { arcRadii.push(r); };
      if (prop === 'measureText') return () => ({ width: 8 });
      return () => {};
    },
    set(target, prop, v) { target[prop] = v; return true; },
  });

  let ts = 0;

  const winListeners = {};
  const els = new Map();
  const store = Object.assign({}, opts.store || {});

  /* 布局桩：画布按 800×600 撑满，触屏按钮 62×62，并按真实 CSS 排布。
     ⚠️ 按钮的 top 不能一律填 0。measureTouchPad 是拿"按钮顶边到画布底边"
     的距离反算 HUD 让位高度的，top 全填 0 会算出一个远大于真实值的数 ——
     这个函数看起来在跑、实际量的是假数据，等于没测。 */
  const BTN = 62;
  const btnTop = 600 - 14 - BTN;   // 底部一行：bottom 14px + 按钮高 62px
  // 兜底矩形绝不能给 top: 0。这个坑刚踩过一次：新增 AI 按钮后忘了在这里声明，
  // 它落到兜底分支上，于是"按钮顶边到画布底边"= 整个画布高度，
  // 让位高度被算成 620（画布才 600 高）—— 测试确实"跑"了，量的是垃圾数据。
  // 现在兜底改成"假设它也在底部那一行"，并把未声明的 id 记下来供断言检查。
  const undeclaredBtns = [];
  const rectOf = (id) => {
    if (id === 'game') return { x: 0, y: 0, top: 0, left: 0, width: 800, height: 600 };
    if (id === 'touch-weapon') return { x: 14, y: btnTop, top: btnTop, left: 14, width: BTN, height: BTN };
    if (id === 'touch-speed')  return { x: 86, y: btnTop, top: btnTop, left: 86, width: BTN, height: BTN };
    if (id === 'touch-ai')     return { x: 652, y: btnTop, top: btnTop, left: 652, width: BTN, height: BTN };
    if (id === 'touch-dash')   return { x: 724, y: btnTop, top: btnTop, left: 724, width: BTN, height: BTN };
    if (undeclaredBtns.indexOf(id) < 0) undeclaredBtns.push(id);
    return { x: 0, y: btnTop, top: btnTop, left: 0, width: BTN, height: BTN };
  };

  const makeEl = (id) => {
    const cls = new Set();
    const listeners = {};
    return {
      id, width: 0, height: 0, textContent: '', innerHTML: '',
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
      },
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener() {},
      blur() {},
      getContext: () => ctxStub,
      getBoundingClientRect: () => rectOf(id),
      setPointerCapture() {},
      releasePointerCapture() {},
      /** 测试专用：手动派发一个事件到该元素 */
      fire(type, ev) { (listeners[type] || []).forEach((f) => f(ev)); },
    };
  };

  const documentStub = {
    readyState: 'complete',
    addEventListener() {},
    getElementById(id) { if (!els.get(id)) els.set(id, makeEl(id)); return els.get(id); },
  };
  const win = {
    addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    // matchMedia 只在显式要求"伪装触屏"时才认；默认返回 false 走桌面分支
    matchMedia: () => ({ matches: !!opts.coarse }),
  };
  const sandbox = {
    window: win,
    document: documentStub,
    navigator: { maxTouchPoints: opts.touchPoints || 0 },
    // pointerdown 处理器会调 performance.now() 做单击/拖动判定 ——
    // Node 的精简 vm 上下文里没有这个全局，必须补上，否则一按就 ReferenceError
    performance: { now: () => ts },
    requestAnimationFrame: (cb) => { pending = cb; return 1; },
    console,
  };
  let pending = null;
  const context = vm.createContext(sandbox);
  vm.runInContext('Math.random = () => ' + randomValue + ';', context);
  vm.runInContext(code, context, { filename: 'space-shooter.js' });

  const hook = win.__SpaceLine;
  if (!hook) throw new Error('未找到 window.__SpaceLine 验证钩子');

  return {
    fillTexts, arcRadii, store, win,
    undeclaredBtns,
    el: (id) => documentStub.getElementById(id),
    G: hook.game,
    CFG: hook.CFG,
    Input: hook.Input,
    AutoPilot: hook.AutoPilot,
    cls: () => hook.classes,
    dispatch(type, key, repeat = false) {
      (winListeners[type] || []).forEach((f) => f({ key, repeat, preventDefault() {} }));
    },
    /** 向 window 派发一个任意事件（用来测那些挂在 window 上的兜底监听） */
    fireWin(type, ev) { (winListeners[type] || []).forEach((f) => f(ev)); },
    /** 派发一个指针事件到画布（坐标为画布逻辑坐标，桩里 1:1） */
    pointer(type, x, y, pointerId = 1, pointerType = 'touch') {
      documentStub.getElementById('game').fire(type, {
        clientX: x, clientY: y, pointerId, pointerType, preventDefault() {},
      });
    },
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        if (!pending) throw new Error('主循环停止：没有排下一帧');
        const cb = pending; pending = null;
        ts += 1000 / 60;
        cb(ts);
      }
    },
    score() {
      for (let i = fillTexts.length - 1; i >= 0; i--) {
        const m = /^SCORE (\d+)$/.exec(fillTexts[i]);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    },
    clear() { fillTexts.length = 0; arcRadii.length = 0; },
  };
}

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  ' + extra : ''));
  if (ok) pass++; else fail++;
};

// ============================ 场景 A ============================
console.log('场景 A：敌人正中下落（验证射击得分 / 暂停）');
{
  const env = createEnv(0.5);
  env.step(3);
  check('初始显示开始界面', env.el('ov-title').textContent === '星 际 防 线' && env.el('ov-btn').textContent === '开始游戏');

  env.dispatch('keydown', ' ');
  env.step(1);
  check('空格开始 → 覆盖层隐藏', env.el('overlay').classList.contains('hidden'));

  let maxScore = 0, deathThrown = false;
  for (let i = 0; i < 3600; i++) {
    env.clear();
    env.dispatch('keydown', ' ', true);   // 模拟按住空格连发
    env.step(1);
    const s = env.score();
    if (s !== null && s > maxScore) maxScore = s;
    // 玩家在正中原地不动，敌人正中下落 → 应在接触前被击落，生命不应减少
    if (!env.el('overlay').classList.contains('hidden')) { deathThrown = true; break; }
  }
  check('持续射击可击毁敌人并累计得分', maxScore > 0, '60 秒得分 = ' + maxScore);
  check('正中持续火力下未被击落', !deathThrown);
  check('gameOver 前生命未被扣除（三命仍在）', env.fillTexts.length > 0);

  env.dispatch('keydown', 'p');
  env.step(1);
  check('P 暂停 → 显示暂停界面', env.el('ov-title').textContent === '已 暂 停');
  env.dispatch('keydown', 'p');
  env.step(1);
  check('再按 P 继续 → 覆盖层隐藏', env.el('overlay').classList.contains('hidden'));
}

// ============================ 场景 B ============================
console.log('\n场景 B：敌人偏左落空（验证精英敌 / 漏怪扣命 / 结束 / 重开）');
{
  const env = createEnv(0.05);
  env.step(3);
  env.dispatch('keydown', ' ');     // 开始，但不按住空格 → 不开火
  env.dispatch('keyup', ' ');
  env.step(1);

  let frames = 0, eliteDrawn = false, ended = false;
  for (let i = 0; i < 2400; i++) {
    env.clear();
    env.step(1);
    frames++;
    if (env.arcRadii.some((r) => r > 10)) eliteDrawn = true;   // 精英敌内圈半径 R*0.45≈12.2
    if (!env.el('overlay').classList.contains('hidden') && i > 10) { ended = true; break; }
  }
  const secs = (frames / 60).toFixed(1);
  check('精英敌绘制分支被执行', eliteDrawn);
  check('漏怪到底会被扣命直至游戏结束', ended, secs + ' 秒后结束');
  check('结束界面标题正确', env.el('ov-title').textContent === '任 务 失 败');
  check('结算面板含得分/存活/等级', /本局得分/.test(env.el('ov-stats').innerHTML));
  check('最高分写入 localStorage', env.store['space-line-best'] !== undefined, 'best=' + env.store['space-line-best']);

  env.dispatch('keydown', 'r');
  env.step(3);
  check('按 R 可重新开始', env.el('overlay').classList.contains('hidden'));
}

// ============================ 场景 C ============================
console.log('\n场景 C：屏幕震动 + 连击倍率（回归 CFG.SHAKE_* 缺失导致的静默失效）');
{
  const env = createEnv(0.5);
  const G = env.G;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.step(1);

  let maxShakeTime = 0, maxShakeMag = 0, sawNaN = false, earlyMult = null;
  for (let i = 0; i < 2400; i++) {
    env.dispatch('keydown', ' ', true);
    env.step(1);

    // 旧 bug 的表现：Math.max(0, undefined) → NaN → 震动永久不触发且不报错。
    // 所以这里同时断言"有限"和"曾经大于零"，两件事都得成立。
    if (!Number.isFinite(G.shakeTime) || !Number.isFinite(G.shakeMag)) sawNaN = true;
    if (G.shakeTime > maxShakeTime) maxShakeTime = G.shakeTime;
    if (G.shakeMag > maxShakeMag) maxShakeMag = G.shakeMag;

    if (i === 300) earlyMult = G.multiplier;
  }
  check('震动时长/幅度全程为有限数（未出现 NaN）', !sawNaN);
  check('击毁敌人确实触发了屏幕震动', maxShakeTime > 0 && maxShakeMag > 0,
        'maxTime=' + maxShakeTime + ' maxMag=' + maxShakeMag);
  check('连击倍率随连续击杀提升', G.multiplier > earlyMult && G.multiplier > 1,
        'x' + earlyMult + ' → x' + G.multiplier + '（' + G.combo + ' 连击）');
  check('倍率不超过配置上限', G.multiplier <= env.CFG.COMBO.MAX_LEVEL + 1,
        'x' + G.multiplier + ' ≤ x' + (env.CFG.COMBO.MAX_LEVEL + 1));

  // ---- 漏怪必须断连 ----
  const before = G.multiplier;
  const Enemy = env.cls().Enemy;
  const e = new Enemy(1);
  e.y = 900;                      // 直接丢到画面下方之外 → 触发"漏怪"
  G.enemies.push(e);
  const lives0 = G.player.lives;
  env.step(1);
  check('漏怪会断连（倍率归 x1、连击清零）', G.combo === 0 && G.multiplier === 1,
        'x' + before + ' → x' + G.multiplier);
  check('漏怪同时扣 1 点生命', G.player.lives === lives0 - 1,
        lives0 + ' → ' + G.player.lives);
}

// ============================ 场景 D ============================
console.log('\n场景 D：道具掉落 / 拾取 / 效果');
{
  const env = createEnv(0.3);      // 0.3 → 掉落判定通过，且权重表抽到「散射」
  const G = env.G, CFG = env.CFG;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.dispatch('keyup', ' ');
  env.step(1);

  // ---- 走真实的掉落函数与拾取链路 ----
  G.maybeDrop({ x: G.player.x, y: G.player.y - 30, elite: true });
  const dropped = G.powerups.length;
  const type = dropped ? G.powerups[0].type : null;
  check('击毁精英敌按概率掉落道具', dropped === 1, 'type=' + type);

  env.step(3);   // 道具在玩家身边 → 磁吸 + 拾取
  check('掉落的道具被磁吸拾取', G.powerups.length === 0);
  const timerOf = { shield: 'shieldTime', spread: 'spreadTime', rapid: 'rapidTime' };
  const effectOK = type === 'life' ? G.player.lives > CFG.PLAYER.LIVES
                 : (type === 'bomb' ? true : G.player[timerOf[type]] > 0);
  check('拾取后对应效果立即生效', effectOK,
        type + ' → ' + (type === 'life' ? 'lives=' + G.player.lives : timerOf[type] + '=' + (G.player[timerOf[type]] || 0).toFixed(2)));

  // ---- 五种道具逐个验证 ----
  const p = G.player;
  p.shieldTime = p.spreadTime = p.rapidTime = 0;
  G.applyPowerUp('shield');
  check('护盾道具生效', p.shieldTime > 0, p.shieldTime.toFixed(1) + 's');
  G.applyPowerUp('spread');
  check('散射道具生效', p.spreadTime > 0, p.spreadTime.toFixed(1) + 's');
  G.applyPowerUp('rapid');
  check('急速道具生效', p.rapidTime > 0, p.rapidTime.toFixed(1) + 's');

  p.lives = 1;
  G.applyPowerUp('life');
  check('加命道具生效', p.lives === 2);
  p.lives = CFG.PLAYER.MAX_LIVES;
  G.applyPowerUp('life');
  check('生命不会超过上限', p.lives === CFG.PLAYER.MAX_LIVES, 'MAX=' + CFG.PLAYER.MAX_LIVES);

  // ---- 散射真的变成三发 ----
  p.cooldown = 0;
  const shots = p.shoot();
  check('散射道具让单次射击变成 3 发', shots.length === 3, shots.length + ' 发');

  // ---- 护盾优先破盾而不是扣命 ----
  p.shieldTime = CFG.POWERUP.SHIELD_TIME;
  p.invincible = 0;
  const livesBefore = p.lives;
  G.damagePlayer();
  check('受击时护盾优先破盾、不扣命',
        p.shieldTime === 0 && p.lives === livesBefore,
        'lives=' + p.lives + ' shield=' + p.shieldTime);
  check('破盾后附带一小段无敌以免被连击秒杀', p.invincible > 0, p.invincible.toFixed(2) + 's');
}

// ============================ 场景 E ============================
console.log('\n场景 E：冲刺（Shift）');
{
  const env = createEnv(0.5);
  const G = env.G, CFG = env.CFG;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.dispatch('keyup', ' ');
  env.step(1);

  const p = G.player;
  check('初始状态冲刺可用', p.dashCd <= 0 && !p.isDashing);

  env.dispatch('keydown', 'd');       // 按住右键 → 冲刺方向朝右
  const x0 = p.x;
  env.dispatch('keydown', 'shift');
  check('按 Shift 进入冲刺状态', p.isDashing === true);
  check('冲刺期间获得无敌', p.isInvincible === true);

  env.step(9);                        // 冲刺持续 0.16s ≈ 10 帧
  const moved = p.x - x0;
  check('冲刺把飞船沿输入方向推出去', moved > 60, '位移 ' + Math.round(moved) + 'px');

  env.step(6);
  check('冲刺结束后进入冷却', p.dashCd > 0, 'cd=' + p.dashCd.toFixed(2) + 's');

  const xAfter = p.x;
  env.dispatch('keydown', 'shift');
  check('冷却中再次冲刺被拒绝', !p.isDashing);
  env.step(6);
  check('冷却期间只以普通速度移动', p.x - xAfter < 60,
        '位移 ' + Math.round(p.x - xAfter) + 'px（冲刺同样帧数约 90px）');
  check('冲刺冷却时长与配置一致', Math.abs(CFG.DASH.COOLDOWN - 1.1) < 1e-6);
}

// ============================ 场景 F ============================
console.log('\n场景 F：BOSS 战');
{
  const env = createEnv(0.5);
  const G = env.G, CFG = env.CFG;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.dispatch('keyup', ' ');
  env.step(1);

  check('低等级不会出现 BOSS', G.boss === null);

  // 把存活时间直接推到 BOSS 等级所需秒数（等级由 elapsed 推导，不能直接改 level）
  G.elapsed = CFG.DIFFICULTY.SECONDS_PER_LEVEL * CFG.BOSS.EVERY_LEVELS;
  env.step(2);
  check('到达 BOSS 等级会召唤 BOSS', G.boss !== null,
        'Lv.' + G.level + ' → boss#' + G.bossIndex);
  check('BOSS 血量与配置一致', G.boss.hp === CFG.BOSS.BASE_HP && G.boss.hp === G.boss.maxHp,
        G.boss.hp + ' HP');

  // 让它就位并发一次火
  const b = G.boss;
  b.entered = true;
  b.fireTimer = 0;
  env.step(2);
  check('BOSS 会周期性发射敌方子弹', G.enemyBullets.length > 0,
        G.enemyBullets.length + ' 发在飞');

  // ---- 敌弹命中玩家要扣命 ----
  G.enemyBullets.length = 0;
  G.player.invincible = 0;
  const lives0 = G.player.lives;
  G.enemyBullets.push(new (env.cls().EnemyBullet)(G.player.x, G.player.y - 4, 0, 0, '#ff6b8a'));
  env.step(1);
  check('被 BOSS 弹命中会扣命', G.player.lives === lives0 - 1,
        lives0 + ' → ' + G.player.lives);

  // ---- 击破 ----
  // 测试替身：冻结 BOSS 的横向机动，让玩家的直射弹稳定命中。
  // 不冻的话它在 300px 幅度上左右摆，射线会周期性错开，验证变成碰运气。
  b.update = function () {};
  b.x = G.player.x;
  b.y = 220;
  b.hp = 1;
  G.player.invincible = 0;
  G.enemies.length = 0;
  G.spawnTimer = 9999;          // 关掉小怪，隔离出纯粹的"玩家 vs BOSS"链路

  const score0 = G.score;
  for (let i = 0; i < 150 && G.boss; i++) {
    env.dispatch('keydown', ' ', true);
    env.step(1);
  }
  check('持续射击可以击破 BOSS', G.boss === null);
  check('击破 BOSS 给高额分数', G.score - score0 >= CFG.BOSS.SCORE,
        '+' + (G.score - score0) + '（基础 ' + CFG.BOSS.SCORE + ' × 倍率）');
  check('击破 BOSS 掉落 3 个道具', G.powerups.length === 3, G.powerups.length + ' 个');
}

// ============================ 场景 G ============================
console.log('\n场景 G：清屏炸弹');
{
  const env = createEnv(0.5);
  const G = env.G;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.dispatch('keyup', ' ');
  env.step(1);

  const Enemy = env.cls().Enemy, EnemyBullet = env.cls().EnemyBullet;
  G.enemies.length = 0;
  G.enemyBullets.length = 0;
  for (let i = 0; i < 6; i++) {
    const e = new Enemy(1);
    e.x = 90 + i * 120;
    e.y = 140;
    G.enemies.push(e);
  }
  G.enemyBullets.push(new EnemyBullet(400, 300, 0, 100, '#ff6b8a'));
  G.enemyBullets.push(new EnemyBullet(430, 320, 0, 100, '#ff6b8a'));

  G.combo = 7;                       // 人为造一个连击，验证炸弹不会打断它
  const score0 = G.score;

  G.applyPowerUp('bomb');
  check('炸弹清空场上所有敌人', G.enemies.length === 0);
  check('炸弹同时清空敌方子弹', G.enemyBullets.length === 0);
  check('炸弹按半价结算清屏分数', G.score > score0, '+' + (G.score - score0));
  check('炸弹不打断连击', G.combo === 7, 'combo=' + G.combo);
}

// ============================ 场景 H ============================
console.log('\n场景 H：触屏 / 鼠标控制');
{
  // coarse=1 → 伪装成触摸设备（matchMedia('(pointer: coarse)') 命中）
  const env = createEnv(0.5, { coarse: true, touchPoints: 5 });
  const G = env.G, CFG = env.CFG, Input = env.Input;
  env.step(3);

  check('触摸设备自动进入触屏模式', G.touchMode === true);
  check('触屏模式给底部 HUD 留出空间', G.hudBottomPad > 0, 'pad=' + G.hudBottomPad + 'px');

  env.dispatch('keydown', ' ');
  env.step(1);

  // ---- 相对拖动：位移应等于"手指位移 × 增益"，而不是"飞船跳到手指位置" ----
  const p = G.player;
  const sx = p.x, sy = p.y;
  env.pointer('pointerdown', 200, 460);
  env.pointer('pointermove', 260, 420);      // 手指 +60 / -40
  env.step(20);                              // 指数插值需要几帧才收敛
  const dx = p.x - sx, dy = p.y - sy;
  const gain = CFG.TOUCH.DRAG_GAIN;
  check('拖动产生相对位移（手指移多远、飞船移多远 × 增益）',
        Math.abs(dx - 60 * gain) < 6 && Math.abs(dy + 40 * gain) < 6,
        'Δ=' + Math.round(dx) + ',' + Math.round(dy) + '（期望 ' + Math.round(60 * gain) + ',' + Math.round(-40 * gain) + '）');
  check('飞船没有"跳到手指位置"（避免被手指挡住）', Math.abs(dx) < 200,
        '|Δx|=' + Math.round(Math.abs(dx)) + ' ≪ 手指位移基准');

  // ---- 触摸下自动开火 ----
  check('触摸按住时自动开火', Input.shoot === true);
  const b0 = G.bullets.length;
  env.step(12);
  check('自动开火真的打出子弹', G.bullets.length > b0 || env.score() !== null,
        '子弹 ' + b0 + ' → ' + G.bullets.length);

  // ---- 多指保护：第二根手指按下不得顶掉拖动基准 ----
  const shipBefore = { x: p.x, y: p.y };
  env.pointer('pointerdown', 700, 120, 2);   // 第二根手指（比如按屏幕按钮的那根）
  env.pointer('pointermove', 700, 120, 2);
  env.step(1);
  check('第二根手指不会顶掉拖动基准（多指保护）',
        Math.abs(p.x - shipBefore.x) < 12 && Math.abs(p.y - shipBefore.y) < 12,
        'Δ=' + Math.round(p.x - shipBefore.x) + ',' + Math.round(p.y - shipBefore.y));

  // ---- 松开后停止跟随 ----
  env.pointer('pointerup', 240, 430, 1);
  env.step(1);
  check('松手后不再跟随（不会飘到手指最后的位置）', Input.pointer.active === false);

  // ---- 屏幕冲刺按钮 ----
  p.dashCd = 0;
  const dashFrom = { x: p.x, y: p.y };
  env.el('touch-dash').fire('pointerdown', { preventDefault() {} });
  // 按钮只是"置位一个一次性请求"，真正触发冲刺发生在下一帧的 Game.update 里
  // （这样键盘 Shift 与屏幕按钮才能共用同一条路径）
  check('屏幕冲刺按钮置位一次性请求', Input.pointer.dashRequest === true);
  env.step(1);
  check('屏幕冲刺按钮触发冲刺', p.isDashing === true);
  check('冲刺请求被消费（读后即清，不会连按连冲）', Input.pointer.dashRequest === false);
  env.step(12);
  // 这里量的是"总位移"而不是 x 位移：此刻手指已经松开、方向键也没按，
  // 冲刺会退回默认的"向上脱险"方向，只在 y 上有位移。
  const dashMoved = Math.hypot(p.x - dashFrom.x, p.y - dashFrom.y);
  check('屏幕冲刺按钮把飞船推出去', dashMoved > 30,
        '位移 ' + Math.round(dashMoved) + 'px（方向：默认向上）');

  // ---- 冲刺按钮只在游戏中生效 ----
  env.dispatch('keydown', 'p');           // 暂停
  env.step(1);
  p.dashCd = 0;
  env.el('touch-dash').fire('pointerdown', { preventDefault() {} });
  env.step(1);
  check('暂停时冲刺按钮无效（不会产生副作用）', p.isDashing === false);

  // ---- 鼠标（pointerType=mouse）也走同一套逻辑 ----
  const env2 = createEnv(0.5);            // 默认桌面：matchMedia 为 false
  env2.step(3);
  env2.dispatch('keydown', ' ');
  env2.step(1);
  check('桌面环境不显示触屏按钮', env2.G.touchMode === false);
  const q = env2.G.player;
  const mx = q.x;
  env2.pointer('pointerdown', 300, 480, 7, 'mouse');
  env2.pointer('pointermove', 380, 480, 7, 'mouse');
  env2.step(20);
  check('鼠标拖动与触摸共用同一套相对拖动',
        Math.abs((q.x - mx) - 80 * env2.CFG.TOUCH.DRAG_GAIN) < 8,
        'Δx=' + Math.round(q.x - mx));
  // 鼠标事件不该被误判成触摸（否则带触摸屏的笔记本会平白多出两个按钮）
  check('鼠标事件不会触发触屏模式', env2.G.touchMode === false);

  // ---- 兜底：桌面 UA 但玩家真的用手指了，也要切到触屏模式 ----
  env2.fireWin('pointerdown', { pointerType: 'touch' });
  check('兜底：第一次真实触摸后自动切到触屏模式', env2.G.touchMode === true);
}

// ============================ 场景 I ============================
console.log('\n场景 I：多武器系统（单发 / 双列 / 激光）');
{
  const env = createEnv(0.5);
  const G = env.G, CFG = env.CFG, p = env.G.player;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.dispatch('keyup', ' ');
  env.step(1);

  check('开局只有单发一把武器', p.weapons.length === 1 && p.weapon === 'pulse',
        p.weapons.join('/'));

  // ---- 单发：一次一发 ----
  p.cooldown = 0;
  check('单发武器一次射 1 颗', p.shoot().length === 1);

  // ---- 双列：一次两发，且是横向平行而非角度外扩 ----
  G.applyPowerUp('twin');
  check('吃到双列道具后立即解锁并装备', p.weapons.includes('twin') && p.weapon === 'twin');
  p.cooldown = 0;
  const twinShots = p.shoot();
  check('双列武器一次射 2 颗', twinShots.length === 2, twinShots.length + ' 发');
  check('双列是平行弹道（角度为 0、横向错开）',
        twinShots[0].vx === twinShots[1].vx && Math.abs(twinShots[0].x - twinShots[1].x) > 10,
        'Δx=' + Math.abs(Math.round(twinShots[0].x - twinShots[1].x)) + 'px');
  check('双列子弹有独立的视觉标记', twinShots[0].twin === true);

  // ---- 激光：不发实体子弹，改为按 dt 结算伤害 ----
  G.applyPowerUp('laser');
  check('吃到激光道具后立即解锁并装备', p.weapon === 'laser' && p.usingLaser === true);
  p.cooldown = 0;
  check('激光不产生实体子弹', p.shoot().length === 0);

  const dps = CFG.WEAPON.LASER.dps;
  const d1 = p.laserDamage(1);            // 1 秒的伤害
  check('激光伤害按 dt 线性结算（帧率无关）', Math.abs(d1 - dps) < 1e-6,
        '1s = ' + d1.toFixed(2) + ' dmg');
  const dHalf = p.laserDamage(1 / 120);
  check('激光在 120Hz 下的每秒伤害与 60Hz 相同',
        Math.abs(dHalf * 120 - p.laserDamage(1 / 60) * 60) < 1e-6,
        '120Hz×120 = ' + (dHalf * 120).toFixed(2));

  // ---- 激光穿透：一条光柱上的多个敌人应同时吃伤害 ----
  const Enemy = env.cls().Enemy;
  G.enemies.length = 0;
  G.spawnTimer = 9999;
  p.x = 400; p.y = 520; p.weapon = 'laser';
  const hp = [];
  for (let i = 0; i < 3; i++) {
    const e = new Enemy(1);
    e.elite = true; e.hp = 99; e.maxHp = 99;   // 加厚血量，避免一帧就被打死而看不出"同时"
    e.x = 400; e.y = 320 - i * 60;
    e.speed = 0; e.vx = 0;
    G.enemies.push(e);
    hp.push(e.hp);
  }
  env.dispatch('keydown', ' ', true);        // 按住开火 → 走激光通道
  env.step(1);
  const allHit = G.enemies.length === 3 && G.enemies.every((e, i) => e.hp < hp[i]);
  check('激光穿透：一条光柱上的 3 个敌人同时受伤', allHit,
        G.enemies.map((e) => e.hp.toFixed(2)).join(' / '));

  // ---- 光柱之外的目标不该被打到 ----
  const far = new Enemy(1);
  far.elite = true; far.hp = 99; far.maxHp = 99;
  far.x = 120; far.y = 320; far.speed = 0; far.vx = 0;
  G.enemies.push(far);
  const farHp = far.hp;
  env.step(1);
  check('光柱之外的目标不受激光伤害', far.hp === farHp, 'hp=' + far.hp);

  // ---- 无效伤害保护：激光不该是"每帧固定值" ----
  // 若误写成每帧固定伤害，60 帧后的总伤害会是 dps（而不是 dps×1 秒）
  const e2 = G.enemies[0];
  e2.hp = e2.maxHp = 9999;
  const before2 = e2.hp;
  env.step(60);
  const perSecond = before2 - e2.hp;
  check('激光 1 秒（60 帧）的总伤害 ≈ DPS，而不是 60×DPS',
        Math.abs(perSecond - dps) < dps * 0.05,
        '实测 ' + perSecond.toFixed(2) + ' ≈ ' + dps);

  // ---- 切换武器 ----
  G.enemies.length = 0;
  env.dispatch('keyup', ' ');
  env.dispatch('keydown', 'q');
  check('Q 键循环切换武器', p.weapon !== 'laser', '→ ' + p.weapon);
  env.dispatch('keydown', '1');
  check('数字键 1 直接切到单发', p.weapon === 'pulse');
  env.dispatch('keydown', '3');
  check('数字键 3 直接切到激光', p.weapon === 'laser');

  // ---- 未解锁的武器不能被切过去 ----
  const fresh = createEnv(0.5);
  fresh.step(3);
  fresh.dispatch('keydown', ' ');
  fresh.dispatch('keyup', ' ');
  fresh.step(1);
  fresh.dispatch('keydown', '3');
  check('未解锁的武器切不过去（锁定机制有效）', fresh.G.player.weapon === 'pulse');

  // ---- 已解锁的武器不会再作为道具掉出来 ----
  G.enemies.length = 0;
  G.powerups.length = 0;
  let sawUnlocked = false;
  for (let i = 0; i < 60; i++) {
    G.maybeDrop({ x: 400, y: 200, elite: true });
    for (const pu of G.powerups) {
      if (pu.type === 'twin' || pu.type === 'laser') sawUnlocked = true;
    }
    G.powerups.length = 0;
  }
  check('已解锁的武器不会再重复掉落（奖励不浪费）', !sawUnlocked);
}

// ============================ 场景 J ============================
console.log('\n场景 J：BOSS 三阶段形态');
{
  const env = createEnv(0.5);
  const G = env.G, CFG = env.CFG;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.dispatch('keyup', ' ');
  env.step(1);

  G.elapsed = CFG.DIFFICULTY.SECONDS_PER_LEVEL * CFG.BOSS.EVERY_LEVELS;
  env.step(2);
  const b = G.boss;
  check('BOSS 初始为一阶段', b.phase === 1 && b.phaseByHp === 1);

  // ---- 阈值按剩余血量比例判定 ----
  b.hp = b.maxHp * (CFG.BOSS.PHASE_2_AT - 0.01);
  check('血量降到 66% 以下进入二阶段', b.phaseByHp === 2, (b.hp / b.maxHp * 100).toFixed(0) + '% HP');
  b.hp = b.maxHp * (CFG.BOSS.PHASE_3_AT - 0.01);
  check('血量降到 33% 以下进入三阶段', b.phaseByHp === 3, (b.hp / b.maxHp * 100).toFixed(0) + '% HP');

  // ---- syncPhase 只在"刚变"的那一帧返回新阶段 ----
  b.hp = b.maxHp;
  b.phase = 1;
  b.hp = b.maxHp * 0.5;
  const first = b.syncPhase();
  const second = b.syncPhase();
  check('syncPhase 只在阶段刚变化时返回新阶段', first === 2 && second === null,
        'first=' + first + ' second=' + second);

  // ---- 阶段切换的表现层反馈 ----
  b.phase = 1;
  b.hp = b.maxHp;
  G.enemyBullets.push(new (env.cls().EnemyBullet)(400, 300, 0, 0, '#ff6b8a'));
  // 先把上一次召唤 BOSS 留下的震屏清掉，否则这里的断言会变成
  // "在衰减中的旧震动"和"新震动"比大小，测出什么全看运气
  G.shakeTime = 0;
  G.shakeMag = 0;
  b.hp = b.maxHp * (CFG.BOSS.PHASE_2_AT - 0.01);
  env.step(1);                             // Game.update → onBossPhase
  check('阶段切换会震屏', G.shakeTime > 0 && G.shakeMag > 0,
        'shake=' + G.shakeTime.toFixed(2) + 's / ' + G.shakeMag + 'px');
  check('阶段切换会播横幅', G.bannerTime > 0 && G.banner.length > 0, '「' + G.banner + '」');
  check('阶段切换会清空场上敌弹（给玩家一个喘息节拍）', G.enemyBullets.length === 0);
  check('阶段切换触发爆闪环', b.phaseFlash > 0, b.phaseFlash.toFixed(2) + 's');

  // ---- 阶段决定横移速度 / 开火间隔 / 弹幕形态 ----
  b.phase = 1; const s1 = b.swaySpeed, f1 = b.fireInterval, n1 = b.spreadCount;
  b.phase = 2; const s2 = b.swaySpeed, f2 = b.fireInterval, n2 = b.spreadCount;
  b.phase = 3; const s3 = b.swaySpeed, f3 = b.fireInterval, n3 = b.spreadCount;
  check('阶段越高横移越快', s1 < s2 && s2 < s3, s1 + ' < ' + s2 + ' < ' + s3);
  check('阶段越高开火越密', f1 > f2 && f2 > f3, f1 + 's > ' + f2 + 's > ' + f3 + 's');
  check('阶段越高扇形弹数越多', n1 === 1 && n2 === CFG.BOSS.SPREAD_2 && n3 === CFG.BOSS.SPREAD_3,
        n1 + ' → ' + n2 + ' → ' + n3);
  b.phase = 2;
  check('只有三阶段附带环形弹幕', b.hasRing === false);
  b.phase = 3;
  check('三阶段开启环形弹幕', b.hasRing === true);

  // ---- 实际开火：二阶段扇形 3 发；三阶段 3+14 发 ----
  const fireAndCount = (phase) => {
    b.phase = phase;
    b.entered = true;
    G.enemyBullets.length = 0;
    G.bossFire();
    return G.enemyBullets.length;
  };
  const n2real = fireAndCount(2);
  check('二阶段一次射出 3 发扇形弹', n2real === CFG.BOSS.SPREAD_2, n2real + ' 发');
  const n3real = fireAndCount(3);
  check('三阶段一次射出扇形 + 环形弹幕',
        n3real === CFG.BOSS.SPREAD_3 + CFG.BOSS.RING_3,
        n3real + ' 发 = ' + CFG.BOSS.SPREAD_3 + ' 扇形 + ' + CFG.BOSS.RING_3 + ' 环形');

  // 扇形是以"正对玩家"为中心的：中心那一发应该指向玩家
  b.phase = 2;
  b.x = 400; b.y = 120;
  G.player.x = 400; G.player.y = 560;
  G.enemyBullets.length = 0;
  G.bossFire();
  const straight = G.enemyBullets.filter((eb) => Math.abs(eb.vx) < 1 && eb.vy > 0).length;
  check('扇形中心那一发正对玩家（玩家有明确的第一处理目标）', straight === 1,
        straight + ' 发垂直向下');

  // ---- 阶段是"血量算出来的"，不能被外部乱改后自相矛盾 ----
  // 这条防的是"手动设了 phase 但没同步血量"的假三阶段：
  // syncPhase 每帧都会按血量重新判定，所以外部改 phase 是无效的，
  // 阶段状态永远只有血量一个真相来源。
  b.hp = b.maxHp * 0.1;
  env.step(2);
  check('阶段状态以血量比例为准（每帧自动同步）', b.phase === 3 && b.phaseByHp === 3,
        'hp=' + (b.hp / b.maxHp * 100).toFixed(0) + '% → phase=' + b.phase);
}

// ============================ 场景 K ============================
console.log('\n场景 K：本地排行榜 Top 5');
{
  // ---- 空存档：榜单不显示 ----
  const envA = createEnv(0.5, { store: { 'space-line-best': '777' } });
  envA.step(3);
  check('旧版最高分被迁移进榜单（老玩家的记录不会凭空消失）',
        envA.G.scores.length === 1 && envA.G.scores[0].score === 777,
        'scores=' + JSON.stringify(envA.G.scores));
  check('迁移后最高分保持一致', envA.G.best === 777);
  check('排行榜渲染到覆盖层', envA.el('ov-board').innerHTML.indexOf('本 地 排 行 榜') >= 0);
  check('有记录时榜单可见', envA.el('ov-board').classList.contains('show'));

  // ---- 脏数据清洗 ----
  const envB = createEnv(0.5, {
    store: {
      'space-line-scores': JSON.stringify([
        { score: 'abc', level: 1, elapsed: 1, ts: 1 },
        { score: -5, level: 1, elapsed: 1, ts: 1 },
        null,
        { score: 320, level: 4, elapsed: 61.5, ts: 1 },
        { score: 900, level: 9, elapsed: 120, ts: 1 },
        { score: 150, level: 2, elapsed: 30, ts: 1 },
        { score: 640, level: 6, elapsed: 88, ts: 1 },
        { score: 210, level: 3, elapsed: 44, ts: 1 },
      ]),
    },
  });
  envB.step(3);
  const listB = envB.G.scores;
  check('脏数据（字符串 / 负数 / null）被过滤掉', listB.length === 5,
        '原始 8 条 → 有效 5 条');
  check('榜单按分数降序排列', listB.every((e, i) => i === 0 || listB[i - 1].score >= e.score),
        listB.map((e) => e.score).join(' > '));
  check('榜单最多保留 5 条', listB.length === envB.CFG.BOARD.KEEP);
  check('清洗后最高分取自榜首', envB.G.best === 900, 'best=' + envB.G.best);

  // ---- 打完一局：写入 + 报出名次 ----
  const env = createEnv(0.5);
  const G = env.G;
  env.step(3);
  env.dispatch('keydown', ' ');
  env.dispatch('keyup', ' ');
  env.step(1);
  G.score = 4321;
  G.elapsed = 95.4;
  G.level = 7;
  G.gameOver();
  env.step(1);

  check('结束后成绩写入 localStorage', !!env.store['space-line-scores'],
        'len=' + JSON.parse(env.store['space-line-scores']).length);
  check('本局名次被记录下来', G.lastRank === 1, '第 ' + G.lastRank + ' 名');
  check('结算界面报出本局名次', /本局排名/.test(env.el('ov-stats').innerHTML));
  check('榜单里本局那一条被高亮', /class="brow now"/.test(env.el('ov-board').innerHTML));

  // ---- 第二名：不应被高亮、名次正确 ----
  G.start();
  G.score = 500;
  G.gameOver();
  env.step(1);
  check('低分成绩排在第 2 名', G.lastRank === 2, '第 ' + G.lastRank + ' 名');
  const rows = env.el('ov-board').innerHTML.split('brow now').length - 1;
  check('高亮的永远只有一条（本局那条）', rows === 1, '高亮 ' + rows + ' 条');
  check('第二轮成绩仍保留在榜上',
        JSON.parse(env.store['space-line-scores']).length === 2,
        JSON.parse(env.store['space-line-scores']).map((e) => e.score).join(' / '));

  // ---- 掉出榜单：名次为 0，不再高亮 ----
  for (let i = 0; i < 6; i++) {
    G.start();
    G.score = 10000 + i * 100;
    G.gameOver();
    env.step(1);
  }
  G.start();
  G.score = 1;                 // 低到必然被挤出 Top5
  G.gameOver();
  env.step(1);
  check('没进前 5 名时名次为 0', G.lastRank === 0);
  check('没进榜时结算不显示"本局排名"', !/本局排名/.test(env.el('ov-stats').innerHTML));
  check('榜单始终只有 5 条（不会越存越多）',
        JSON.parse(env.store['space-line-scores']).length === 5,
        JSON.parse(env.store['space-line-scores']).map((e) => e.score).join(' / '));
  check('重开后清掉上一局的名次高亮', (() => {
    G.start();
    const html = env.el('ov-board').innerHTML;
    return html.indexOf('brow now') < 0 && G.lastRank === 0;
  })());

  // ---- localStorage 抛异常时不能把游戏搞崩 ----
  const envC = createEnv(0.5);
  envC.step(3);
  envC.win.localStorage.getItem = () => { throw new Error('SecurityError'); };
  envC.win.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  let crashed = false;
  try {
    envC.G.loadBest();
    envC.G.score = 100;
    envC.G.recordScore();
  } catch (err) { crashed = true; }
  check('隐私模式/配额超限下读写存档不崩溃（静默降级）', !crashed);
}

// ============================ 场景 L ============================
console.log('\n场景 L：二倍速模式');
{
  const env = createEnv(0.5);
  const G = env.G, CFG = env.CFG, S = CFG.SPEED;
  env.step(2);

  check('开局为常速', G.timeScale === S.NORMAL, 'timeScale = ' + G.timeScale);

  // 档位开关不做状态限制：在开始界面先把档位设好再开局是正常用法
  env.dispatch('keydown', 'f');
  env.step(1);
  check('开始界面上按 F 也能切档', G.timeScale === S.FAST);
  env.dispatch('keydown', 'f');
  env.step(1);
  check('再按 F 切回常速', G.timeScale === S.NORMAL);

  env.dispatch('keydown', ' ');
  env.step(1);
  env.dispatch('keydown', 'f');
  env.step(1);
  check('游戏中按 F 切到二倍速', G.timeScale === S.FAST);

  /* ---- 时间真的被放大了吗 ----
     关键：绝不能只断言 timeScale 这个字段。字段写对了、但 frame() 里忘了用它
     （或者用错了顺序），恰恰是"改一处漏一处"这类改动最容易留下的问题。
     所以这里量的是"同样 60 个真实帧里，游戏时间走了多少"。 */
  const e0 = G.elapsed, r0 = G.realElapsed;
  env.step(60);
  const dGame = G.elapsed - e0;
  const dReal = G.realElapsed - r0;
  check('二倍速期间游戏仍在进行（下面的计时断言才有意义）', G.state === 'playing');
  check('游戏内时间流速确实是 2 倍', Math.abs(dGame - 2 * dReal) < 0.02,
        '游戏 +' + dGame.toFixed(3) + 's / 真实 +' + dReal.toFixed(3) + 's');
  check('真实存活计时不受倍速影响（结算里不能说假话）',
        Math.abs(dReal - 1.0) < 0.02, '真实 +' + dReal.toFixed(3) + 's（期望 1.000s）');

  /* ---- 逻辑步长必须仍被 MAX_DT 夹住 ----
     如果缩放发生在夹紧之前，最大步长会变成 1/15 秒，高速子弹一帧能跨 40 像素，
     可能整个跳过敌机的碰撞圆 —— 那会表现为"二倍速偶尔打不中"的玄学 bug。 */
  let maxStep = 0;
  const origUpdate = G.update.bind(G);
  G.update = (dt) => { if (dt > maxStep) maxStep = dt; return origUpdate(dt); };
  env.step(10);
  G.update = origUpdate;
  check('二倍速下逻辑步长仍被 MAX_DT 夹住（防隧道效应）',
        maxStep <= CFG.MAX_DT + 1e-9,
        '实测最大步长 ' + maxStep.toFixed(5) + 's ≤ ' + CFG.MAX_DT.toFixed(5) + 's');

  // ---- HUD 角标 ----
  env.clear();
  env.step(1);
  check('二倍速时 HUD 显示 ×2 角标', env.fillTexts.indexOf(S.TAG) >= 0);
  check('SCORE 那一行没有被拼进倍速标记（自检靠它反解分数）',
        env.score() !== null, 'score = ' + env.score());

  env.dispatch('keydown', 'f');     // 切回常速
  env.step(1);
  env.clear();
  env.step(1);
  check('常速时不显示角标', env.fillTexts.indexOf(S.TAG) < 0);

  /* ---- 榜单：加速局必须带标记 ----
     不标的话，"×2 打出来的分"和"常速打出来的分"混在同一张榜上，
     这张榜就失去了可比性 —— 而排行版本来的意义就是可比。 */
  G.timeScale = S.FAST;
  G.score = 4321;
  G.realElapsed = 12.3;
  G.gameOver();                      // 走真实路径：recordScore + 刷新覆盖层

  const saved = JSON.parse(env.store['space-line-scores'] || '[]');
  check('加速局的成绩被记录为 sp=2', saved.length > 0 && saved[0].sp === S.FAST,
        JSON.stringify(saved[0]));
  check('结算界面标注了本局是二倍速', env.el('ov-stats').innerHTML.indexOf('二倍速') >= 0);
  check('榜单把倍速标记渲染出来', env.el('ov-board').innerHTML.indexOf('class="sp"') >= 0);

  // ---- 脏数据：sp 只认 2 ----
  const cleaned = G.sanitizeScores([
    { score: 100, sp: 2 },
    { score: 90, sp: 999 },
    { score: 80, sp: 'x' },
    { score: 70 }
  ]);
  check('sp 只认 2，被篡改的值一律归为常速',
        cleaned[0].sp === S.FAST && cleaned[1].sp === S.NORMAL &&
        cleaned[2].sp === S.NORMAL && cleaned[3].sp === S.NORMAL,
        cleaned.map((e) => e.sp).join(' / '));

  // ---- 档位跨局保留 ----
  G.timeScale = S.FAST;
  G.start();
  check('重开一局后仍保持二倍速档位（它是难度档位，不是本局状态）',
        G.timeScale === S.FAST);
  check('重开一局后真实存活计时归零', G.realElapsed === 0);
}

// ---- 触屏：倍速按钮 ----
{
  const env = createEnv(0.5, { coarse: true, touchPoints: 5 });
  const G = env.G, S = env.CFG.SPEED;
  env.step(3);

  check('触屏模式出现倍速按钮', !!env.el('touch-speed'));
  env.dispatch('keydown', ' ');
  env.step(1);

  env.el('touch-speed').fire('pointerdown', { preventDefault() {} });
  env.step(1);
  check('屏幕倍速按钮能切档', G.timeScale === S.FAST);
  check('按钮文字跟着档位变成 ×2',
        env.el('touch-speed-text').textContent === S.TAG,
        '文字 = ' + env.el('touch-speed-text').textContent);
  check('开到二倍速时按钮点亮（.on）',
        env.el('touch-speed').classList.contains('on') === true);

  env.el('touch-speed').fire('pointerdown', { preventDefault() {} });
  env.step(1);
  check('再按一次回到常速：档位、文字、点亮状态一起复位',
        G.timeScale === S.NORMAL &&
        env.el('touch-speed-text').textContent === '1×' &&
        env.el('touch-speed').classList.contains('on') === false);

  /* ---- 回归：让位高度必须按"整摞按钮"算，而不是只看某一颗 ----
     这个 bug 真发生过：倍速按钮一度叠在换枪按钮正上方，而 measureTouchPad
     只量了冲刺按钮的高度，算出的让位高度不够 ——
     结果倍速按钮正好压住左下角 WEAPON 那一行字，而且不报任何错。
     手法：临时把倍速按钮的矩形挪高一格（模拟叠放），让位高度必须跟着变大。 */
  const speedEl = env.el('touch-speed');
  const realRect = speedEl.getBoundingClientRect;
  G.measureTouchPad();
  const rowPad = G.hudBottomPad;
  speedEl.getBoundingClientRect = () => ({ x: 14, y: 452, top: 452, left: 14, width: 62, height: 62 });
  G.measureTouchPad();
  const stackedPad = G.hudBottomPad;
  speedEl.getBoundingClientRect = realRect;
  G.measureTouchPad();
  check('按钮叠放时底部 HUD 会自动让出更多空间（按整摞算，不是单颗）',
        stackedPad > rowPad,
        '叠放 ' + stackedPad + 'px > 单排 ' + rowPad + 'px');
  check('单排布局下让位高度回到原值（+20 呼吸空间，未重复计算下边距）',
        G.hudBottomPad === rowPad, 'pad=' + G.hudBottomPad + 'px');
}

// ============================ 场景 M ============================
console.log('\n场景 M：AI 自动模式');
{
  const env = createEnv(0.5);
  const G = env.G, CFG = env.CFG, AI = env.AutoPilot, cls = env.cls();

  check('默认不接管（AI 必须由玩家显式开启）', AI.on === false);
  check('虚拟手柄已挂上钩子（否则下面所有断言都会静默失效）', !!AI && !!AI.input);

  // ---- 开关：它是档位，不做状态限制 ----
  env.step(2);
  env.dispatch('keydown', 'i');
  env.step(1);
  check('开始界面上按 I 就能进入接管（与 F 二倍速同一套考虑）', AI.on === true);
  env.dispatch('keydown', 'i');
  env.step(1);
  check('再按 I 交还操作', AI.on === false);

  // ---- 开局后自动开火 ----
  // 用 G.start() 而不是按空格开局：按空格会把 keys[' '] 置为按下状态，
  // 而"按着空格"本身就会被判成手动输入把 AI 踢掉 —— 那是 M6 要单独测的东西。
  AI.engage(G);
  G.start();
  env.step(1);
  check('开局后仍处于接管状态', AI.on === true && G.state === 'playing');

  let shotsFired = 0;
  const origShoot = G.player.shoot.bind(G.player);
  G.player.shoot = () => { const r = origShoot(); shotsFired += r.length; return r; };
  env.step(30);
  G.player.shoot = origShoot;
  check('AI 在没有人按键的情况下自己开火', shotsFired > 0,
        '0.5 秒内自动打出 ' + shotsFired + ' 发');

  /* ---- 核心：AI 到底会不会躲 ----
     造一个"必中"的局面：清空全场，只留三颗正对飞船头顶砸下来的敌弹。
     关键是必须有对照组 —— 如果 AI 关闭时这个局面也不掉命，
     那"AI 躲开了"这条断言就是空转的，它什么也没证明。
     （这正是"一个不会失败的检查比没有检查更糟"的具体做法。） */
  const origSpawning = G.updateSpawning;
  const aimed = (frames, autoOn) => {
    G.updateSpawning = () => {};        // 停掉自然刷怪，保证场面完全可控
    G.enemies.length = 0;
    G.enemyBullets.length = 0;
    G.bullets.length = 0;
    G.powerups.length = 0;
    G.player.reset();
    G.player.x = CFG.W / 2;
    G.player.y = CFG.H * 0.72;
    if (autoOn) AI.engage(G); else AI.disengage(G, 'toggle');
    AI.reset();

    const lives0 = G.player.lives;
    const x0 = G.player.x;
    for (let i = 0; i < 3; i++) {
      G.enemyBullets.push(new cls.EnemyBullet(
        CFG.W / 2, 120 + i * 40, 0, CFG.BOSS.BULLET_SPEED, '#ff3b5c'));
    }
    env.step(frames);
    return { lives0, lives: G.player.lives, moved: Math.abs(G.player.x - x0) };
  };

  const ctrl = aimed(150, false);
  check('对照组：AI 关闭时同样局面必然掉命（证明下面那条断言不是空转）',
        ctrl.lives < ctrl.lives0,
        '生命 ' + ctrl.lives0 + ' → ' + ctrl.lives);

  const auto = aimed(150, true);
  check('AI 接管时同样局面毫发无伤',
        auto.lives === auto.lives0,
        '生命 ' + auto.lives0 + ' → ' + auto.lives);
  check('而且是靠横向移动躲开的，不是站在原地侥幸没事',
        auto.moved > 30, '横向位移 ' + auto.moved.toFixed(1) + 'px');
  check('躲开之后没有一路逃到角落（平滑项在起作用）',
        auto.moved < 380, '横向位移 ' + auto.moved.toFixed(1) + 'px');

  G.updateSpawning = origSpawning;

  // ---- 手动输入立刻夺回 ----
  G.player.x = 300;
  G.player.y = CFG.H * 0.72;
  AI.engage(G);
  env.step(1);
  env.dispatch('keydown', 'd');
  env.step(1);
  check('玩家一按键（D 右移）AI 立刻交还控制权', AI.on === false);
  const xBefore = G.player.x;
  env.step(20);
  check('交还之后飞船确实听键盘的', G.player.x > xBefore + 20,
        xBefore.toFixed(1) + ' → ' + G.player.x.toFixed(1));
  env.dispatch('keyup', 'd');
  env.step(1);

  // ---- 摁着空格也会夺回（这条走的是"状态检测"而不是一次性按键）----
  AI.engage(G);
  env.step(1);
  env.dispatch('keydown', ' ');
  env.step(1);
  check('按住空格（开火）也算手动输入，同样夺回控制权', AI.on === false);
  env.dispatch('keyup', ' ');
  env.step(1);

  // ---- 换枪：必须有滞后，否则会在边界上反复横跳 ----
  G.player.weapons = ['pulse', 'twin', 'laser'];
  G.player.weapon = 'pulse';
  G.enemies.length = 0;
  for (let i = 0; i < 3; i++) {
    const e = new cls.Enemy(1);
    e.x = 100 + i * 300;          // 横向铺开 → 应该选双列
    e.y = 180 - i * 10;
    e.vx = 0;
    G.enemies.push(e);
  }
  AI._wantWeapon = '';
  AI._wantHits = 0;
  AI._decideWeapon(G);
  check('换枪有滞后：第一次评估不立刻换（防止在 2↔3 架的边界上反复横跳）',
        G.player.weapon === 'pulse', 'weapon = ' + G.player.weapon);
  AI._decideWeapon(G);
  check('同一判断连续两次成立后才真的换枪', G.player.weapon === 'twin',
        'weapon = ' + G.player.weapon);

  // ---- HUD 角标 ----
  AI.engage(G);
  env.clear();
  env.step(1);
  check('接管时 HUD 显示 AI 角标', env.fillTexts.indexOf(CFG.AI.TAG) >= 0);
  check('SCORE 那一行没被角标污染（自检靠它反解分数）', env.score() !== null,
        'score = ' + env.score());

  // ---- 榜单：接管局必须带标记 ----
  // 不标的话，"完美走位的 AI 打出来的分"和真人成绩混在同一张榜上，
  // 这张榜对真人就彻底失去参照意义了 —— 和倍速标记是同一类问题。
  G.enemies.length = 0;
  G.score = 9999;
  G.gameOver();

  const saved = JSON.parse(env.store['space-line-scores'] || '[]');
  check('接管局的成绩被记录为 ai=1', saved.length > 0 && saved[0].ai === 1,
        JSON.stringify(saved[0]));
  check('结算界面点名了本局是 AI 接管', env.el('ov-stats').innerHTML.indexOf('AI') >= 0);
  check('榜单把 AI 标记渲染出来', env.el('ov-board').innerHTML.indexOf('class="ai"') >= 0);

  const cleaned = G.sanitizeScores([
    { score: 100, ai: 1 },
    { score: 90, ai: 999 },
    { score: 80, ai: 'x' },
    { score: 70 }
  ]);
  check('ai 只认 1，被篡改的值与缺失一律算真人局',
        cleaned[0].ai === 1 && cleaned[1].ai === 0 &&
        cleaned[2].ai === 0 && cleaned[3].ai === 0,
        cleaned.map((e) => e.ai).join(' / '));

  // ---- 重开一局不该把档位关掉 ----
  AI.engage(G);
  G.start();
  env.step(1);
  check('重开一局后仍保持接管（它是档位，不是本局状态）', AI.on === true);
  check('重开一局后接管计时归零', AI.engaged < 0.1, 'engaged = ' + AI.engaged.toFixed(3));
}

// ============================ 场景 N ============================
console.log('\n场景 N：AI 的触屏入口');
{
  const env = createEnv(0.5, { coarse: true, touchPoints: 5 });
  const G = env.G, AI = env.AutoPilot;
  env.step(3);

  check('触屏模式出现 AI 按钮', !!env.el('touch-ai'));
  env.el('touch-ai').fire('pointerdown', { preventDefault() {} });
  env.step(1);
  check('点 AI 圆钮就能进入接管（手机上按不了 I）', AI.on === true);
  check('按钮文字变成 ON，玩家一眼知道现在谁在操作',
        env.el('touch-ai-text').textContent === 'ON',
        '文字 = ' + env.el('touch-ai-text').textContent);
  check('接管时按钮点亮（.on）', env.el('touch-ai').classList.contains('on') === true);

  env.el('touch-ai').fire('pointerdown', { preventDefault() {} });
  env.step(1);
  check('再点一次交还，文字与点亮状态一起复位',
        AI.on === false &&
        env.el('touch-ai-text').textContent === 'AI' &&
        env.el('touch-ai').classList.contains('on') === false);

  /* ---- 布局桩的覆盖率 ----
     这条是给"以后再加按钮"准备的：measureTouchPad 会遍历 game 上声明的按钮，
     只要有一个按钮没在桩里声明几何，它就会掉进兜底分支、量出垃圾数据。
     这个坑刚踩过一次（AI 按钮忘了声明 → 让位高度算成 620px，画布才 600 高）。 */
  G.measureTouchPad();
  check('自检的布局桩已覆盖页面上所有触屏按钮',
        env.undeclaredBtns.length === 0, env.undeclaredBtns.join(', '));
}

console.log(fail === 0
  ? '\n🎉 全部 ' + pass + ' 项检查通过，无运行时异常'
  : '\n⚠️ ' + pass + ' 项通过 / ' + fail + ' 项未通过');
process.exit(fail === 0 ? 0 : 1);