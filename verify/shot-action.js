/**
 * 动作镜头实拍：用 headless Edge 打开游戏，通过 window.__SpaceLine 钩子把局面
 * 强制推进到"有内容可看"的状态（BOSS 战 / 满连击 / 三种道具生效 / 爆炸），
 * 然后截图。目的不是验证逻辑（那是 selftest.js 的活），而是拿到能直观看到
 * 新版美术效果的画面。
 *
 * 用法: node verify/shot-action.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const CWD = __dirname;
const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(CWD, '_edgeprofile_action'),
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
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!targets) { console.log('无法连接到 headless Edge'); cleanup(); process.exit(1); }

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
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push('console.error: ' + JSON.stringify(msg.params.args.map((a) => a.value ?? a.description)));
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; waiters.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  };
  const key = (type, k, code, vk) => send('Input.dispatchKeyEvent', {
    type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, 20000);
    fs.writeFileSync(path.join(CWD, file), Buffer.from(r.result?.data || r.data, 'base64'));
    console.log('  📷 ' + file);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });

  for (let i = 0; i < 40; i++) {
    if ((await evaluate('document.readyState')) === 'complete') break;
    await sleep(200);
  }
  // 等到钩子和主循环都就绪（canvases/DOM 也可能稍后才齐，所以轮询多个条件）
  for (let i = 0; i < 40; i++) {
    const ok = await evaluate('!!(window.__SpaceLine && window.__SpaceLine.game && document.getElementById("ov-title"))');
    if (ok) break;
    await sleep(200);
  }
  await sleep(600);

  // ---- 开局 ----
  await key('keyDown', ' ', 'Space', 32);
  await key('keyUp', ' ', 'Space', 32);
  await sleep(400);

  // ---- 用钩子把局面推到"好看"的状态 ----
  // 说明：这是验证专用手段，正常玩游戏拿不到这种局面。
  //
  // ⚠️ 布景有一个必须注意的点：摆出来的敌机一定要 speed=0 / vx=0（悬停）。
  //    第一版忘了这件事，敌机照常下落，落到底部就算"漏怪" → 扣命 + 连击清零，
  //    于是截图里 HUD 的连击条和护盾全都消失了（看起来像 HUD 有 bug，其实是布景错了）。
  const stage = `(function(){
    var G = window.__SpaceLine.game, C = window.__SpaceLine.CFG;
    var cls = window.__SpaceLine.classes;

    // 1) 分数 / 存活时间：level 是由 elapsed 推导的（level = 1 + floor(elapsed/16)），
    //    只改 G.level 会在下一帧被 update() 覆盖掉，所以要让 HUD 的 LEVEL 与
    //    场上的 BOSS 自洽，必须改 elapsed。
    G.score = 12480;
    G.best  = 12480;
    G.elapsed = C.DIFFICULTY.SECONDS_PER_LEVEL * 5;   // → Lv.6

    // 2) 连击拉满（22 连击 → x5 倍率）
    G.combo = 22;
    G.comboTimer = C.COMBO.WINDOW;

    // 3) 三种持续型道具同时生效，展示 HUD 上的道具条
    G.player.shieldTime = C.POWERUP.SHIELD_TIME;
    G.player.spreadTime = C.POWERUP.SPREAD_TIME;
    G.player.rapidTime  = C.POWERUP.RAPID_TIME;
    G.player.invincible = 0;

    // 4) 召唤 BOSS
    G.updateBoss(1/60);

    // 5) 摆几架敌机当构图元素（悬停，不让它们掉出去）
    var ys = [104, 168, 238, 306, 366];
    for (var i = 0; i < ys.length; i++) {
      var e = new cls.Enemy(6);
      e.x = 118 + i * 146;
      e.y = ys[i];
      e.spin = i * 0.5;
      e.speed = 0;      // 悬停：不参与"漏怪"判定
      e.vx = 0;
      G.enemies.push(e);
    }
    return { boss: !!G.boss, hp: G.boss && G.boss.hp, mult: G.multiplier };
  })()`;

  await evaluate(stage);
  await evaluate(stage);   // 跑两次：第一次之后主循环可能已推进一帧并改了 elapsed，再钉一次

  await sleep(220);   // 让 BOSS 预警横幅先显示出来

  const st = await evaluate('(function(){var G=window.__SpaceLine.game;return {boss:!!G.boss,hp:G.boss&&G.boss.hp,mult:G.multiplier,combo:G.combo};})()');
  console.log('  局面: BOSS=' + st.boss + ' 血量=' + st.hp + ' 连击=' + st.combo + ' 倍率=x' + st.mult);

  await shot('_shot_4_boss-warn.png');

  // ---- 等横幅消失，按住空格让子弹真的出现在画面里 ----
  await sleep(2400);

  // 真实按住空格（走 Input 状态对象，和真人按键等价，不是手动往数组里塞）
  await key('keyDown', ' ', 'Space', 32);
  // 按住左移，让飞船偏左，画面构图更好看
  await key('keyDown', 'a', 'KeyA', 65);
  await sleep(420);
  await key('keyUp', 'a', 'KeyA', 65);

  // ---- 爆炸必须放在截图前 100 多毫秒内制造 ----
  // 原因：粒子寿命只有 0.25~0.65 秒、冲击波更短，
  // 早造 400ms 就已经全部消失，截图里什么都拍不到（第一版就是这么白忙一场的）。
  await evaluate(`(function(){
    var G = window.__SpaceLine.game, C = window.__SpaceLine.CFG;
    var cls = window.__SpaceLine.classes;
    // 两处爆炸：一红一金，覆盖两种敌色系。
    // 不用另外补冲击波 —— explode() 内部已经配了一环（半径随当量缩放），
    // 手动再加环只会拍出玩家平时看不到的画面。
    G.explode(250, 250, '#ff5d7a', 26, 1.3);
    G.explode(560, 200, '#ffb457', 34, 1.5);
    // 把 BOSS 血量打掉一半，让血条看起来"正在被打"
    if (G.boss) G.boss.hp = Math.round(G.boss.maxHp * 0.45);
    // 三种道具也续满（同样是被"截图本身耗时"拖掉的），让 HUD 道具条看起来完整
    G.player.shieldTime = C.POWERUP.SHIELD_TIME;
    G.player.spreadTime = C.POWERUP.SPREAD_TIME;
    G.player.rapidTime  = C.POWERUP.RAPID_TIME;
    // 重新钉一次连击：连击窗口只有 3.2 秒，而"截一张图"本身就要 0.3~0.6 秒
    // （软件渲染下更慢），所以两张截图之间连击一定会自然过期。
    // ⚠️ 必须同时补 combo 和 comboTimer —— 只补 comboTimer 是没用的，
    //    update() 里断连判断被「if (combo > 0)」保护着，combo 已是 0 就什么都不做。
    G.combo = 22;
    G.comboTimer = C.COMBO.WINDOW;
    return true;
  })()`);
  await sleep(130);

  const st2 = await evaluate('(function(){var G=window.__SpaceLine.game;return {bullets:G.bullets.length,parts:G.particles.length,sw:G.shockwaves.length};})()');
  console.log('  交战: 子弹=' + st2.bullets + ' 粒子=' + st2.parts + ' 冲击波=' + st2.sw);

  await shot('_shot_5_boss-fight.png');
  await key('keyUp', ' ', 'Space', 32);

  // ---- 炸弹清屏：制造"全屏爆破"的画面 ----
  // BOSS 先请走，否则它会挡住爆炸的构图（BOSS 不参与炸弹清屏的视觉）
  await evaluate(`(function(){
    var G = window.__SpaceLine.game;
    var cls = window.__SpaceLine.classes;
    if (G.boss) G.boss.hp = 1;          // 让它在下一轮子弹下自然被击破，不粗暴删对象
    // 铺一批敌机，让爆炸有地方发生（悬停，别掉出画面）
    for (var i = 0; i < 8; i++) {
      var e = new cls.Enemy(7);
      e.x = 95 + i * 96;
      e.y = 120 + (i % 4) * 96;
      e.speed = 0; e.vx = 0; e.spin = i * 0.7;
      G.enemies.push(e);
    }
    return true;
  })()`);
  await sleep(160);

  // 走真实的炸弹道具逻辑（applyPowerUp('bomb')），而不是手搓爆炸 ——
  // 这样截出来的画面和玩家真吃到炸弹时看到的是同一条代码路径。
  const bombRes = await evaluate(`(function(){
    var G = window.__SpaceLine.game;
    var before = G.enemies.length;
    G.applyPowerUp('bomb');
    return { before: before, after: G.enemies.length,
             sw: G.shockwaves.length, parts: G.particles.length };
  })()`);
  console.log('  炸弹: 敌机 ' + bombRes.before + ' → ' + bombRes.after +
              '  冲击波=' + bombRes.sw + ' 粒子=' + bombRes.parts);

  await sleep(130);
  await shot('_shot_6_bomb.png');

  console.log('\n控制台错误/未捕获异常：' + (problems.length ? '\n  ' + problems.join('\n  ') : '无'));

  ws.close();
  cleanup();
  await sleep(300);
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.log('脚本出错:', e.message); process.exit(1); });
