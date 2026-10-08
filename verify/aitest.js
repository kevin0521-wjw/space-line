/**
 * AI 自动驾驶长跑诊断：让 AI 自己打完整局，统计「能活多久」和「死因分布」。
 *
 * 为什么单独写一个：
 *   selftest 的场景 M 只在一个受控局面（三颗正对头顶的弹）里证明了 AI 会躲；
 *   browsertest 只跑了 1.5 秒。两者都回答不了「AI 自己打能撑多久、是怎么死的」。
 *   而这恰恰是玩家唯一能感知的指标。
 *
 * 关键手法：**把主循环的 requestAnimationFrame 断掉，用固定 1/60 步长手动推进**。
 *   走的是和真机完全相同的 frame() → update() 代码路径（含 dt 夹紧、碰撞判定），
 *   但不再受墙钟限制，一局几分钟的游戏几秒内就能跑完，于是可以跑很多局看分布。
 *
 * 死因分类的依据：全库只有 4 处会扣命（已逐处核对 damagePlayer 的调用点）——
 *   敌机本体、Boss 本体、敌方子弹、漏怪。分类方法是在「命数下降的那一帧」
 *   对比前后两帧的实体数组：本帧消失、且上一帧与玩家相撞的那个实体就是凶手；
 *   没有任何实体相撞却有敌机消失 → 漏怪。
 *   （注意 Shockwave 只是视觉，不扣命，所以不在分类里。）
 *
 * 用法：node verify/aitest.js [局数] [每局最多模拟秒数] [截图时刻秒数，0=不截]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9345;
const CWD = __dirname;
const PAGE = 'file:///' + path.join(CWD, '..', 'index.html').replace(/\\/g, '/');

const ROUNDS = Number(process.argv[2] || 3);
const MAX_SEC = Number(process.argv[3] || 300);
/* 第 4 个参数：>0 时在第 1 局快进到该秒数截一张图（0 = 不截）。
   用来在"AI 已经很忙"的时刻取画面，而不是开局 1.5 秒的安静场面。 */
const SHOT_AT = Number(process.argv[4] || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里装好诊断器：断开 rAF、提供 step() 手动推进 */
const INSTALL = `
(function(){
  const NS = window.__SpaceLine;
  const G = NS.game, A = NS.AutoPilot;

  window.requestAnimationFrame = function(){ return 0; };   // 断开自动循环

  const D = {
    events: [],          // 每次掉命
    leaks: 0,            // 累计漏怪数
    frames: 0,
    samples: [],         // 每秒一条行为快照
    lastTs: 0,
    prev: null,
    dead: false,
    // ---- 冲刺专项仪表 ----
    // 「AI 不会按 shift」这种观察必须先被量化，否则改完不知道该看哪个数字。
    dashReq: 0,          // AI 真正发出冲刺请求的帧数
    dashOk: 0,           // 冲刺真的生效的次数（dashCd 从 0 跳到满冷却）
    dashCrisis: 0,       // 其中"硬解"（危险度达阈值）
    dashRush: 0,         // 其中"赶路抢漏怪"
    missedDash: 0,       // 「本可以冲、但没冲」的帧数（危险度已达阈值且冷却就绪）
    maxDanger: 0,        // 全程 AutoPilot.danger 的峰值
    hist: [0, 0, 0, 0, 0],   // 危险度分布：[0,.25) [.25,.5) [.5,1) [1,2) [2,∞)
    dashableDanger: [],  // 冷却就绪时的危险度样本（最优格）—— 反事实标定 DASH_AT 用
    hereDanger: [],      // 冷却就绪时「当前格」的危险度样本 —— 标定"当前格"判据用
    yHist: [0, 0, 0, 0, 0],  // AI 的 y 分布（按活动区间五等分），验证它有没有缩在顶部
    hooked: false,
    prevDashCd: 0,
  };

  function snap() {
    const p = G.player;
    return {
      t: G.realElapsed, lives: p.lives, state: G.state,
      score: G.score, level: G.level,
      px: p.x, py: p.y, pr: p.r, weapon: p.weapon,
      // dashCd 必须带上，否则"冲刺生效"的判定拿 undefined 去比大小，恒为 false
      dashCd: p.dashCd,
      enemies: G.enemies.slice(), bullets: G.enemyBullets.slice(),
    };
  }

  // 命数下降的那一帧：找出凶手
  function classify(before) {
    const pr = G.player.r;
    const dist = (o) => Math.hypot(o.x - before.px, o.y - before.py);
    // 容差 46px：涵盖一帧内实体自身的位移（敌机最快 ~200px/s → 一帧 3.3px，留足余量）
    const near = (o) => dist(o) <= pr + (o.r || 0) + 46;

    const goneE = before.enemies.filter((e) => !G.enemies.includes(e));
    const goneB = before.bullets.filter((b) => !G.enemyBullets.includes(b));

    let cause = null, detail = '';
    let leakGap = null, leakPy = null, leakY = null;
    for (const e of goneE) {
      if (near(e)) { cause = 'enemy-body'; detail = '敌机本体撞击 d=' + Math.round(dist(e)) + 'px'; break; }
    }
    if (!cause) for (const b of goneB) {
      if (near(b)) { cause = 'bullet'; detail = '敌弹命中 d=' + Math.round(dist(b)) + 'px'; break; }
    }
    if (!cause && G.boss && G.boss.entered
        && Math.hypot(G.boss.x - before.px, G.boss.y - before.py) <= pr + 46 + 46) {
      cause = 'boss-body'; detail = 'Boss 本体撞击';
    }
    if (!cause && goneE.length) {
      const lowest = goneE.reduce((a, e) => (e.y > a.y ? e : a), goneE[0]);
      cause = 'leak';
      detail = '漏怪 ' + goneE.length + ' 架（最近那架 y=' + Math.round(lowest.y) + '）';
      // 关键归因：漏怪那一刻敌机离我横向多远？
      //   差得远 = 根本没赶过去（导航问题）；差得近 = 赶到了却没打掉（瞄准/火力问题）
      leakGap = Math.round(Math.abs(lowest.x - before.px));
      leakPy = Math.round(before.py);
      leakY = Math.round(lowest.y);
    }
    if (!cause) cause = 'unknown';

    // ---- 记录当时的取舍（验证「危险度是否压过击杀收益」的直接证据）----
    const here = { d: A._danger(G, before.px, before.py), g: A._gain(G, before.px, before.py) };
    let lowest = null;
    for (const e of G.enemies) if (e.y > 0 && (!lowest || e.y > lowest.y)) lowest = e;
    const kill = lowest
      ? { d: A._danger(G, lowest.x, before.py), g: A._gain(G, lowest.x, before.py), y: Math.round(lowest.y) }
      : null;

    D.events.push({
      t: Number(G.realElapsed.toFixed(2)),
      level: G.level,
      score: G.score,
      cause, detail,
      livesLeft: G.player.lives,
      danger: Number(A.danger.toFixed(2)),        // 死那一刻 AI 眼中的最优格危险度
      dashCd: Number(G.player.dashCd.toFixed(2)),  // >0 = 冷却中，想冲也冲不了
      leakGap, leakPy, leakY,                      // 仅漏怪时有值
      hereScore: Number((here.g - here.d * NS.CFG.AI.SAFETY).toFixed(2)),
      hereDanger: Number(here.d.toFixed(2)),
      hereGain: Number(here.g.toFixed(3)),
      killScore: kill ? Number((kill.g - kill.d * NS.CFG.AI.SAFETY).toFixed(2)) : null,
      killDanger: kill ? Number(kill.d.toFixed(2)) : null,
      killGain: kill ? Number(kill.g.toFixed(3)) : null,
      killY: kill ? kill.y : null,
    });
  }

  D.start = function () {
    D.events = []; D.leaks = 0; D.frames = 0; D.samples = []; D.dead = false;
    D.lastTs = 0; D.prev = null;
    D.dashReq = 0; D.dashOk = 0; D.missedDash = 0; D.dashCrisis = 0; D.dashRush = 0;
    D.maxDanger = 0; D.hist = [0, 0, 0, 0, 0]; D.dashableDanger = [];
    D.hereDanger = []; D.yHist = [0, 0, 0, 0, 0];
    D.prevDashCd = 0;

    // 包一层 think()：它返回时虚拟手柄上就写着本帧的冲刺决定，
    // 而 consumeDash() 要等 Game.update 里下一步才消费 —— 正好是唯一的观察窗口。
    if (!D.hooked) {
      const origThink = A.think.bind(A);
      A.think = function (g, dt) {
        origThink(g, dt);
        if (!A.on) return;
        const d = A.danger;
        if (d > D.maxDanger) D.maxDanger = d;
        if (d < 0.25) D.hist[0]++;
        else if (d < 0.5) D.hist[1]++;
        else if (d < 1) D.hist[2]++;
        else if (d < 2) D.hist[3]++;
        else D.hist[4]++;
        if (A.input._dash) {
          D.dashReq++;
          // 分清两种用途：危险度到阈值的 = 硬解；否则 = 赶路抢漏怪
          if (d >= NS.CFG.AI.DASH_AT) D.dashCrisis++; else D.dashRush++;
        }
        // AI 的纵向落点分布：分成活动区间的五等分
        {
          const gp = g.player;
          const y0 = NS.CFG.H * NS.CFG.AI.Y_MIN_RATIO;
          const y1 = NS.CFG.H * NS.CFG.AI.Y_MAX_RATIO;
          const k = Math.min(4, Math.max(0, Math.floor((gp.y - y0) / ((y1 - y0) / 5))));
          D.yHist[k]++;
        }
        // 反事实样本：只在"冷却就绪、可以冲"的帧上取样，
        // 因为那些帧才是 DASH_AT 真正在做决定的帧
        if (g.player.dashCd <= 0 && !g.player.isDashing) {
          D.dashableDanger.push(Number(d.toFixed(3)));
          D.hereDanger.push(Number(A._danger(g, g.player.x, g.player.y).toFixed(3)));
          if (d >= NS.CFG.AI.DASH_AT && !A.input._dash) D.missedDash++;
        }
      };
      D.hooked = true;
    }

    G._lastTs = 0;
    D.prev = snap();
    return true;
  };

  /** 手动推进 frames 帧，返回是否仍在进行中 */
  D.step = function (frames) {
    for (let i = 0; i < frames; i++) {
      if (G.state !== 'playing') { D.dead = true; return false; }
      D.lastTs += 1000 / 60;
      G.frame(D.lastTs);
      D.frames++;

      const cur = snap();
      if (D.prev) {
        if (cur.lives < D.prev.lives) classify(D.prev);
        // 漏怪计数：pastBottom 的敌机在本帧消失
        for (const e of D.prev.enemies) {
          if (e.pastBottom && !G.enemies.includes(e)) D.leaks++;
        }
      }
      // 冲刺生效判定：dash() 会把 dashCd 从 0 直接拉到满冷却，一帧内跳变 ≈1.1s
      if (cur.dashCd > D.prevDashCd + 0.5) D.dashOk++;
      D.prevDashCd = cur.dashCd;
      D.prev = cur;

      if (D.frames % 60 === 0) {
        D.samples.push({
          t: Number(G.realElapsed.toFixed(1)), lv: G.level, score: G.score,
          lives: G.player.lives, x: Math.round(G.player.x), y: Math.round(G.player.y),
          en: G.enemies.length, bl: G.enemyBullets.length, wp: G.player.weapon,
        });
      }
    }
    return true;
  };

  D.report = function () {
    // 反事实标定：按给定的 DASH_AT 重放一遍"可冲帧"序列，数真正会触发几次冲刺。
    // 必须按顺序重放并扣掉 1.1s 冷却 —— 否则连续几十帧的同一个危机会被数成几十次。
    const THS = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.3, 1.6];
    const COOLDOWN_FRAMES = Math.round(NS.CFG.DASH.COOLDOWN * 60);
    // 两种判据各算一遍：用「最优格」和用「当前格」。哪个能在真实危机时给出非零触发，
    // 哪个才是对的 —— 这是纯数据问题，不该靠猜。
    const replay = (arr, t) => {
      let cd = 0, n = 0;
      for (let i = 0; i < arr.length; i++) {
        if (cd > 0) { cd--; continue; }
        if (arr[i] >= t) { n++; cd = COOLDOWN_FRAMES; }
      }
      return n;
    };
    const cf = THS.map((t) => ({ t, n: replay(D.dashableDanger, t), h: replay(D.hereDanger, t) }));
    return JSON.stringify({
      dead: D.dead,
      frames: D.frames,
      elapsed: Number(G.realElapsed.toFixed(2)),
      score: G.score, level: G.level, lives: G.player.lives,
      leaks: D.leaks,
      dashReq: D.dashReq, dashOk: D.dashOk, missedDash: D.missedDash,
      dashCrisis: D.dashCrisis, dashRush: D.dashRush,
      maxDanger: Number(D.maxDanger.toFixed(2)),
      hist: D.hist,
      yHist: D.yHist,
      dashable: D.dashableDanger.length,
      cf,
      events: D.events,
      samples: D.samples,
    });
  };

  window.__diag = D;
  return 'installed';
})()`;

(async () => {
  const profile = path.join(CWD, '_edgeprofile_ai');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1100,860',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { proc.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await res.json();
      if (targets.length) break;
    } catch (e) {}
    await sleep(250);
  }
  if (!targets) { console.log('❌ 无法连接到 headless Edge'); cleanup(); process.exit(1); }

  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const waiters = new Map();
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg.result || msg.error); waiters.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      problems.push('异常: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; waiters.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) {
      problems.push('求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return undefined;
    }
    return r?.result?.value;
  };
  const key = (type, k, code, vk) => send('Input.dispatchKeyEvent', {
    type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });

  await send('Page.enable');
  await send('Runtime.enable');

  console.log('打开本地页面：' + PAGE);
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 60; i++) {
    if (await evaluate('!!(window.__SpaceLine && window.__SpaceLine.game)')) break;
    await sleep(200);
  }

  console.log('装载诊断器：' + await evaluate(INSTALL));

  // 阈值只在页内存在，取一次供汇总打印用（Node 侧不能直接引用 NS）
  const DASH_AT = await evaluate('__SpaceLine.CFG.AI.DASH_AT');

  const all = [];
  for (let round = 1; round <= ROUNDS; round++) {
    // 重开一局（R 键），再按 I 交给 AI
    await key('keyDown', 'r', 'KeyR', 82); await key('keyUp', 'r', 'KeyR', 82);
    await sleep(120);
    await evaluate('window.__diag && window.__diag.start()');
    // 确保在进行中
    let st = await evaluate('__SpaceLine.game.state');
    if (st !== 'playing') {
      await key('keyDown', ' ', 'Space', 32); await key('keyUp', ' ', 'Space', 32);
      await sleep(150);
    }
    const before = await evaluate('__SpaceLine.AutoPilot.on');
    if (before !== true) {
      await key('keyDown', 'i', 'KeyI', 73); await key('keyUp', 'i', 'KeyI', 73);
      await sleep(120);
    }
    const on = await evaluate('__SpaceLine.AutoPilot.on');

    process.stdout.write('第 ' + round + ' 局：AI=' + on + ' 模拟中');
    let sec = 0;

    /* ---- 顺手拍一张"AI 忙起来"的照片 ----
       数字能证明它打得更好，但玩家关心的是"看起来怎么样"。
       这里直接复用快进能力：跑到第 SHOT_AT 秒截一张，
       免得为了截图再等一分钟真实时间。 */
    if (SHOT_AT > 0) {
      while (sec < SHOT_AT) {
        if (await evaluate('__diag.step(600)') === false) break;
        sec += 10;
      }
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.data) {
        fs.writeFileSync(path.join(CWD, '_shot_12_ai_action.png'), Buffer.from(shot.data, 'base64'));
        console.log('\n  📷 已截图 verify/_shot_12_ai_action.png（' + sec + 's 处）');
      }
    }

    while (sec < MAX_SEC) {
      const alive = await evaluate('__diag.step(600)');   // 10 秒
      sec += 10;
      process.stdout.write('.');
      if (alive === false) break;
    }
    process.stdout.write('\n');

    const rep = JSON.parse(await evaluate('__diag.report()'));
    all.push(rep);
  }

  // ---------------- 汇总 ----------------
  console.log('\n================ AI 自动驾驶诊断报告 ================');
  const causes = {};
  all.forEach((r, i) => {
    console.log('\n第 ' + (i + 1) + ' 局：存活 ' + r.elapsed + 's ・ 到达 Lv.' + r.level
      + ' ・ 得分 ' + r.score + ' ・ 剩余命 ' + r.lives
      + ' ・ 累计漏怪 ' + r.leaks + ' 架'
      + (r.dead ? ' ・ 已阵亡' : ' ・ 未阵亡（截断）'));
    console.log('   冲刺：请求 ' + r.dashReq + ' 帧 ・ 生效 ' + r.dashOk + ' 次（硬解 ' + r.dashCrisis + ' / 赶路 ' + r.dashRush + '）・ 该冲没冲 '
      + r.missedDash + ' 帧 ・ 危险度峰值 ' + r.maxDanger + '（阈值 ' + DASH_AT + '）');
    const tot = r.hist.reduce((a, b) => a + b, 0) || 1;
    console.log('   危险度分布 [0,.25) ' + (r.hist[0] / tot * 100).toFixed(0) + '% ・ [.25,.5) '
      + (r.hist[1] / tot * 100).toFixed(0) + '% ・ [.5,1) ' + (r.hist[2] / tot * 100).toFixed(0)
      + '% ・ [1,2) ' + (r.hist[3] / tot * 100).toFixed(0) + '% ・ [2,∞) '
      + (r.hist[4] / tot * 100).toFixed(0) + '%');
    if (!r.events.length) { console.log('   （没有掉命）'); }
    r.events.forEach((e) => {
      causes[e.cause] = (causes[e.cause] || 0) + 1;
      console.log('   ' + String(e.t).padStart(7) + 's  Lv.' + String(e.level).padEnd(3)
        + '命' + e.livesLeft + '  ' + e.cause.padEnd(11) + ' ' + e.detail
        + '  [当时最优格危险 ' + e.danger + ' / 冲刺冷却 ' + e.dashCd + ']');
      if (e.leakGap !== null) {
        console.log('            漏怪归因：敌机 y=' + e.leakY + '，我当时 y=' + e.leakPy
          + '，横向差 ' + e.leakGap + 'px ' + (e.leakGap > 60 ? '← 压根没赶过去（导航不足）' : '← 赶到了却没打掉（瞄准/火力不足）'));
      }
      if (e.killScore !== null) {
        console.log('            取舍：原地 score=' + e.hereScore
          + ' (危险 ' + e.hereDanger + ' / 收益 ' + e.hereGain + ')'
          + '　最低那架敌机处 score=' + e.killScore
          + ' (危险 ' + e.killDanger + ' / 收益 ' + e.killGain + ', y=' + e.killY + ')');
      }
    });
  });

  console.log('\n---------------- 死因分布 ----------------');
  const total = Object.values(causes).reduce((a, b) => a + b, 0);
  if (!total) console.log('（无）');
  Object.entries(causes).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    const bar = '█'.repeat(Math.round(v / total * 30));
    console.log('  ' + k.padEnd(12) + String(v).padStart(3) + ' 次  ' + (v / total * 100).toFixed(0).padStart(3) + '%  ' + bar);
  });

  console.log('\n---------------- 漏怪归因 ----------------');
  const leaks = all.flatMap((r) => r.events.filter((e) => e.leakGap !== null));
  if (!leaks.length) console.log('（没有漏怪）');
  else {
    const far = leaks.filter((e) => e.leakGap > 60).length;
    const avgGap = leaks.reduce((a, e) => a + e.leakGap, 0) / leaks.length;
    console.log('  样本 ' + leaks.length + ' 次 ・ 平均横向差 ' + avgGap.toFixed(0) + 'px');
    console.log('  没赶过去（>60px）：' + far + ' 次 (' + (far / leaks.length * 100).toFixed(0) + '%)'
      + '　赶到了没打掉：' + (leaks.length - far) + ' 次');
    // 按等级拆开：如果漏怪集中在最高几级，那是"难度饱和"（游戏本来就打不完），
    // 而不是 AI 的走位/瞄准有缺陷 —— 这两件事的改进方向完全不同。
    const byLv = {};
    leaks.forEach((e) => { byLv[e.level] = (byLv[e.level] || 0) + 1; });
    console.log('  按等级拆分：' + Object.keys(byLv).sort((a, b) => a - b)
      .map((lv) => 'Lv.' + lv + '×' + byLv[lv]).join('  '));
    console.log('  平均发生在 Lv.' + (leaks.reduce((a, e) => a + e.level, 0) / leaks.length).toFixed(1));
  }

  console.log('\n---------------- DASH_AT 反事实标定 ----------------');
  console.log('（"可冲帧"总数 ' + all.reduce((a, r) => a + r.dashable, 0) + '；'
    + '下面每一行 = 若阈值取该值，' + all.length + ' 局合计会触发多少次冲刺）');
  console.log('   阈值    「最优格」判据    「当前格」判据');
  const ths = all[0] ? all[0].cf.map((c) => c.t) : [];
  ths.forEach((t, i) => {
    const n = all.reduce((a, r) => a + r.cf[i].n, 0);
    const h = all.reduce((a, r) => a + r.cf[i].h, 0);
    console.log('   ' + String(t).padEnd(7) + String(n).padStart(7) + ' 次' + ' '.repeat(10)
      + String(h).padStart(7) + ' 次');
  });

  console.log('\n---------------- AI 纵向落点分布 ----------------');
  const yh = [0, 0, 0, 0, 0];
  all.forEach((r) => r.yHist.forEach((v, i) => { yh[i] += v; }));
  const yt = yh.reduce((a, b) => a + b, 0) || 1;
  const y0 = 600 * 0.52, y1 = 600 * 0.90, step = (y1 - y0) / 5;
  yh.forEach((v, i) => {
    const lo = Math.round(y0 + i * step), hi = Math.round(y0 + (i + 1) * step);
    console.log('   y ' + String(lo).padStart(3) + '~' + String(hi).padStart(3)
      + '  ' + (v / yt * 100).toFixed(0).padStart(3) + '%  ' + '█'.repeat(Math.round(v / yt * 40)));
  });
  console.log('   （越靠下 = 能打到的敌机越多；挤在上半段说明 AI 在"缩头"）');
  const avg = all.reduce((a, r) => a + r.elapsed, 0) / all.length;
  const avgLeak = all.reduce((a, r) => a + r.leaks, 0) / all.length;
  const sumReq = all.reduce((a, r) => a + r.dashReq, 0);
  const sumOk = all.reduce((a, r) => a + r.dashOk, 0);
  const sumMiss = all.reduce((a, r) => a + r.missedDash, 0);
  const peak = Math.max(...all.map((r) => r.maxDanger));
  console.log('\n平均存活 ' + avg.toFixed(1) + 's ・ 平均漏怪 ' + avgLeak.toFixed(1) + ' 架');
  console.log('冲刺合计：请求 ' + sumReq + ' 帧 ・ 生效 ' + sumOk + ' 次 ・ 该冲没冲 '
    + sumMiss + ' 帧 ・ 危险度峰值 ' + peak.toFixed(2));
  console.log('控制台错误/未捕获异常：' + (problems.length ? '❌\n  ' + problems.slice(0, 6).join('\n  ') : '无 ✅'));

  cleanup();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  console.log('====================================================');
})().catch((e) => {
  console.error('测试脚本自身出错:', e);
  process.exit(1);
});
