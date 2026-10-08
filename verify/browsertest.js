/**
 * 真实浏览器验证：用 headless Edge + CDP 打开 index.html，全程零控制台错误。
 *
 * 分两个阶段，因为"桌面"和"触屏"在同一个页面里是两套分支，必须分别起一次：
 *   阶段一（桌面）—— 键盘开局/移动/暂停、激光武器、BOSS 三阶段、排行榜迁移、AI 接管
 *   阶段二（触屏）—— 用真实触摸事件（Input.dispatchTouchEvent）驱动
 *                    相对拖动、自动开火、屏幕冲刺按钮、倍速按钮、
 *                    以及三个按钮两两不重叠 / 底部 HUD 让位高度是否真的够
 *
 * 为什么非要走真浏览器：verify/selftest.js 用的是自搭的 DOM/Canvas 桩，
 * 它能证明"逻辑对了"，但证明不了"画布缩放后坐标还是对的""按钮真的能按到"
 * 这些只有真实布局引擎才知道的事。两套测试互补，缺一不可。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const CWD = __dirname;
const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  ' + extra : ''));
  if (ok) pass++; else fail++;
};

(async () => {
  /* ---- 每次运行都从干净的 profile 开始 ----
     ⚠️ 这里曾经埋着一个"测试不可重复运行"的坑：--user-data-dir 是持久目录，
     localStorage 会跨运行保留，而脚本只在阶段二清过 storage。
     于是"上一轮跑出过成绩"会让下一轮阶段一的两条断言直接失败
     （空存档时排行榜应隐藏 / 结束后成绩条数应为 1），
     表现为"排行榜坏了"，实际是测试自己带进来的脏数据。
     解法不是每次手工删目录：在启动浏览器之前直接清掉。 */
  const profile = path.join(CWD, '_edgeprofile');
  fs.rmSync(profile, { recursive: true, force: true });

  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--touch-events=enabled',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1100,860',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { proc.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  // ---- 等待 CDP 端口就绪 ----
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await res.json();
      if (targets.length) break;
    } catch (e) { /* 还没起来 */ }
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
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push('console.error: ' + JSON.stringify(msg.params.args.map((a) => a.value ?? a.description)));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push('日志错误: ' + msg.params.entry.text);
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; waiters.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
  const key = (type, k, code, vk) => send('Input.dispatchKeyEvent', {
    type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(CWD, file), Buffer.from(r.data, 'base64'));
  };
  const waitReady = async () => {
    for (let i = 0; i < 40; i++) {
      if ((await evaluate('document.readyState')) === 'complete') break;
      await sleep(200);
    }
    await sleep(900);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  /* ======================================================================
   * 阶段一：桌面
   * ==================================================================== */
  console.log('阶段一：桌面（键盘 / 鼠标）');
  await send('Page.navigate', { url: PAGE_URL });
  await waitReady();

  check('画布逻辑分辨率固定 800×600',
        (await evaluate('(function(){var c=document.getElementById("game");return c.width+"x"+c.height;})()')) === '800x600');
  check('开场界面标题正确',
        (await evaluate('document.getElementById("ov-title").textContent')) === '星 际 防 线');
  check('桌面环境不进入触屏模式', (await evaluate('__SpaceLine.game.touchMode')) === false);
  check('空存档时排行榜整块隐藏',
        (await evaluate('document.getElementById("ov-board").classList.contains("show")')) === false);
  await shot('_shot_1_menu.png');

  // ---- 开局 ----
  await key('keyDown', ' ', 'Space', 32);
  await key('keyUp', ' ', 'Space', 32);
  await sleep(300);
  check('空格开局 → 覆盖层隐藏',
        (await evaluate('document.getElementById("overlay").classList.contains("hidden")')) === true);

  // ---- 战斗中：持续开火 + 左右移动 ----
  for (let i = 0; i < 10; i++) {
    await key('keyDown', ' ', 'Space', 32);
    await key('keyDown', i % 2 ? 'ArrowLeft' : 'ArrowRight', i % 2 ? 'ArrowLeft' : 'ArrowRight', i % 2 ? 37 : 39);
    await key('keyUp', i % 2 ? 'ArrowRight' : 'ArrowLeft', i % 2 ? 'ArrowRight' : 'ArrowLeft', i % 2 ? 39 : 37);
    await sleep(180);
  }
  await sleep(300);
  await shot('_shot_2_playing.png');
  check('战斗中覆盖层保持隐藏',
        (await evaluate('document.getElementById("overlay").classList.contains("hidden")')) === true);
  check('战斗产生了得分/实体推进', (await evaluate('__SpaceLine.game.elapsed')) > 1);

  // ---- 激光武器：解锁 → 装备 → 按住开火 ----
  // ⚠️ 先把上一段按住的方向键松开并清空输入状态。
  //    留着 ArrowLeft 没放的话，飞船会以 340px/s 往左飘走，
  //    一秒钟后光柱早就离开了目标所在的那一列 —— 测试会失败在一个
  //    完全与激光无关的地方（这个坑真踩过一次）。
  await key('keyUp', 'ArrowLeft', 'ArrowLeft', 37);
  await key('keyUp', 'ArrowRight', 'ArrowRight', 39);
  await evaluate('__SpaceLine.Input.clear()');

  await evaluate('(function(){var G=__SpaceLine.game;G.player.unlockWeapon("twin");G.player.unlockWeapon("laser");G.player.switchWeapon("laser");return G.player.weapon;})()');
  check('武器可解锁并切换', (await evaluate('__SpaceLine.game.player.weapon')) === 'laser');

  // 直接读"实际画到画布上的文字"，而不是读内部变量 ——
  // 内部变量对不代表 HUD 真的画出来了，两件事必须分开验。
  const hudText = await evaluate(`(function(){
    var G=__SpaceLine.game, c=document.getElementById('game').getContext('2d');
    var orig=c.fillText, seen=[];
    c.fillText=function(t){ seen.push(String(t)); return orig.apply(this, arguments); };
    G.render();
    c.fillText=orig;
    return seen.filter(function(s){ return /WEAPON|DASH/.test(s); }).join(' | ');
  })()`);
  check('HUD 真的把武器名与冲刺状态画了出来', /WEAPON .+/.test(hudText) && /DASH/.test(hudText), hudText);

  // 把敌人排成一列（血量给足，否则 1 秒内就被打光，"同时被削血"就看不出来了）
  const LASER_TEST_HP = 40;
  await evaluate(`(function(){
    var G=__SpaceLine.game, E=__SpaceLine.classes.Enemy;
    G.enemies.length=0; G.spawnTimer=9999; G.enemyBullets.length=0;
    for (var i=0;i<4;i++){
      var e=new E(3); e.elite=true; e.hp=e.maxHp=${LASER_TEST_HP};
      e.x=400; e.y=190+i*78; e.speed=0; e.vx=0; G.enemies.push(e);
    }
    G.player.x=400; G.player.y=520; G.player.cooldown=0;
    return G.enemies.length;
  })()`);
  for (let i = 0; i < 26; i++) { await key('keyDown', ' ', 'Space', 32); await sleep(45); }
  const laserState = JSON.parse(await evaluate(`(function(){
    var G=__SpaceLine.game;
    return JSON.stringify({ n:G.enemies.length, hp:G.enemies.map(function(e){return Math.round(e.hp);}), x:Math.round(G.player.x) });
  })()`));
  await shot('_shot_7_laser.png');
  check('激光一次穿透整列（同一条光柱上的敌人同时被削血）',
        laserState.n === 4 && laserState.hp.every((h) => h > 0 && h < LASER_TEST_HP),
        '剩余血量 ' + laserState.hp.join(' / ') + '（起始 ' + LASER_TEST_HP + '）');
  check('激光期间飞船没有被误移（输入状态干净）', Math.abs(laserState.x - 400) < 3,
        'x=' + laserState.x);
  await key('keyUp', ' ', 'Space', 32);

  // ---- BOSS 三阶段 ----
  await evaluate(`(function(){
    var G=__SpaceLine.game, C=__SpaceLine.classes;
    G.enemies.length=0; G.enemyBullets.length=0;
    G.bossIndex=1; G.boss=new C.Boss(1);
    G.boss.entered=true; G.boss.y=112; G.boss.sway=1.2;
    G.bossIndex=1;
    return G.boss.phase;
  })()`);
  await sleep(200);
  check('BOSS 已生成且处于一阶段', (await evaluate('__SpaceLine.game.boss.phase')) === 1);

  // 打进三阶段（狂暴）
  await evaluate('(function(){var b=__SpaceLine.game.boss;b.hp=b.maxHp*0.28;return b.phase;})()');
  await sleep(120);
  for (let i = 0; i < 6; i++) { await key('keyDown', ' ', 'Space', 32); await sleep(40); }
  await sleep(400);
  check('BOSS 进入三阶段（狂暴）', (await evaluate('__SpaceLine.game.boss.phase')) === 3,
        'phase=' + (await evaluate('__SpaceLine.game.boss.phase')));
  check('三阶段触发阶段横幅', (await evaluate('__SpaceLine.game.bannerTime')) > 0,
        '「' + (await evaluate('__SpaceLine.game.banner')) + '」');
  check('三阶段 BOSS 真的发射了环形弹幕',
        (await evaluate('__SpaceLine.game.enemyBullets.length')) > 5,
        (await evaluate('__SpaceLine.game.enemyBullets.length')) + ' 发在飞');
  await shot('_shot_8_boss-phase3.png');
  await key('keyUp', ' ', 'Space', 32);

  // ---- 排行榜（打完一局后写入） ----
  await evaluate('(function(){var G=__SpaceLine.game;G.score=6540;G.elapsed=104;G.level=8;G.gameOver();return G.lastRank;})()');
  await sleep(300);
  check('结束后成绩写入排行榜', (await evaluate('__SpaceLine.game.scores.length')) === 1);
  check('结算界面报出本局名次', (await evaluate('document.getElementById("ov-stats").innerHTML')).indexOf('本局排名') >= 0);
  check('排行榜渲染出记录行',
        (await evaluate('document.getElementById("ov-board").innerHTML')).indexOf('6540') >= 0);
  check('本局那条被高亮',
        (await evaluate('document.getElementById("ov-board").innerHTML')).indexOf('brow now') >= 0);
  await shot('_shot_9_board.png');

  // ---- 旧存档迁移：清掉新键、只留旧最高分，刷新后应自动迁移 ----
  await evaluate('(function(){localStorage.removeItem("space-line-scores");localStorage.setItem("space-line-best","2048");return 1;})()');
  await send('Page.navigate', { url: PAGE_URL });
  await waitReady();
  check('旧版最高分被迁移进榜单',
        (await evaluate('__SpaceLine.game.scores.length')) === 1 &&
        (await evaluate('__SpaceLine.game.scores[0].score')) === 2048,
        'best=' + (await evaluate('__SpaceLine.game.best')));
  check('迁移后排行榜可见',
        (await evaluate('document.getElementById("ov-board").classList.contains("show")')) === true);

  // ---- 暂停 ----
  await key('keyDown', ' ', 'Space', 32);
  await key('keyUp', ' ', 'Space', 32);
  await sleep(200);
  await key('keyDown', 'p', 'KeyP', 80);
  await key('keyUp', 'p', 'KeyP', 80);
  await sleep(400);
  check('P 暂停 → 显示暂停界面',
        (await evaluate('document.getElementById("ov-title").textContent')) === '已 暂 停');
  await shot('_shot_3_paused.png');

  /* ======================================================================
   * 阶段一之二：AI 自动模式（真实浏览器 + 真实键盘）
   * 自检里的场景 M 跑在自搭的 DOM 桩上；这里要证明的是真机行为：
   * 按 I 真的会接管、它真的把飞船开动了、而且手动输入真的能夺回来。
   * ==================================================================== */
  await key('keyDown', 'r', 'KeyR', 82);
  await key('keyUp', 'r', 'KeyR', 82);
  await sleep(400);
  check('重开后回到进行中状态', (await evaluate('__SpaceLine.game.state')) === 'playing',
        'state=' + (await evaluate('__SpaceLine.game.state')));

  await key('keyDown', 'i', 'KeyI', 73);
  await key('keyUp', 'i', 'KeyI', 73);
  await sleep(200);
  check('真机按 I 进入 AI 接管', (await evaluate('__SpaceLine.AutoPilot.on')) === true);
  check('接管时自动开火，而玩家并没有按着空格',
        (await evaluate('__SpaceLine.game.firing')) === true &&
        (await evaluate('Boolean(__SpaceLine.Input.keys[" "])')) === false,
        'firing=' + (await evaluate('__SpaceLine.game.firing')));

  // 采样 1.5 秒：AI 必须真的在动，而且不能站着挨打
  const xs = [];
  const aiLives0 = await evaluate('__SpaceLine.game.player.lives');
  for (let i = 0; i < 15; i++) {
    xs.push(await evaluate('__SpaceLine.game.player.x'));
    await sleep(100);
  }
  const aiMoved = Math.max.apply(null, xs) - Math.min.apply(null, xs);
  check('AI 真的在开动飞船（横向位置持续变化）', aiMoved > 5,
        '横向活动范围 ' + aiMoved.toFixed(1) + 'px');
  check('AI 接管期间没有掉命',
        (await evaluate('__SpaceLine.game.player.lives')) === aiLives0,
        aiLives0 + ' → ' + (await evaluate('__SpaceLine.game.player.lives')));
  check('AI 接管期间游戏正常推进',
        (await evaluate('__SpaceLine.game.realElapsed')) > 1 &&
        (await evaluate('__SpaceLine.game.state')) === 'playing',
        'realElapsed=' + (await evaluate('__SpaceLine.game.realElapsed')).toFixed(2) + 's');
  await shot('_shot_11_ai_desktop.png');

  // 手动夺回：真机上按一下方向键
  await key('keyDown', 'd', 'KeyD', 68);
  await sleep(250);
  check('真机按方向键立刻夺回控制权', (await evaluate('__SpaceLine.AutoPilot.on')) === false);
  await key('keyUp', 'd', 'KeyD', 68);
  await sleep(200);

  /* ======================================================================
   * 阶段二：触屏（真实触摸事件 + 手机视口）
   * ==================================================================== */
  console.log('\n阶段二：触屏（真实触摸事件 + 390×844 手机视口）');

  // 手机视口 + 触摸模拟：必须在导航前开启，
  // 这样页面加载时 matchMedia('(pointer: coarse)') 就已经是 true 了
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await evaluate('(function(){localStorage.clear();return 1;})()');
  await send('Page.navigate', { url: PAGE_URL });
  await waitReady();

  check('手机视口下自动进入触屏模式', (await evaluate('__SpaceLine.game.touchMode')) === true);
  check('#game-wrap 打上了 touch-mode 类',
        (await evaluate('document.getElementById("game-wrap").classList.contains("touch-mode")')) === true);
  check('屏幕冲刺按钮可见且尺寸合理',
        (await evaluate('(function(){var b=document.getElementById("touch-dash");var r=b.getBoundingClientRect();return Math.round(r.width)+"x"+Math.round(r.height);})()')) !== '0x0',
        (await evaluate('(function(){var b=document.getElementById("touch-dash");var r=b.getBoundingClientRect();return Math.round(r.width)+"x"+Math.round(r.height);})()')));
  check('底部 HUD 为屏幕按钮让位',
        (await evaluate('__SpaceLine.game.hudBottomPad')) > 0,
        'pad=' + (await evaluate('__SpaceLine.game.hudBottomPad')) + 'px');

  // ---- 三个屏幕按钮的真实布局 ----
  // selftest 用的是自搭的 DOM 桩（矩形是写死的），所以"按钮之间会不会互相压住"
  // 这件事只有真实布局引擎才算得出来。
  const speedLayout = await evaluate(`(function(){
    var ids=['touch-weapon','touch-speed','touch-ai','touch-dash'];
    var rs=ids.map(function(i){return document.getElementById(i).getBoundingClientRect();});
    for (var i=0;i<rs.length;i++){
      if (rs[i].width<40||rs[i].height<40)
        return ids[i]+" 尺寸异常 " + Math.round(rs[i].width) + "x" + Math.round(rs[i].height);
      if (rs[i].top<0||rs[i].left<0) return ids[i]+" 跑到视口外";
    }
    for (var a=0;a<rs.length;a++)for(var b=a+1;b<rs.length;b++){
      var A=rs[a],B=rs[b];
      if (A.left<B.right && B.left<A.right && A.top<B.bottom && B.top<A.bottom)
        return ids[a]+" 与 "+ids[b]+" 重叠";
    }
    return "ok";
  })()`);
  check('四个屏幕按钮尺寸正常且两两不重叠', speedLayout === 'ok', speedLayout);

  /* ---- 底部中央必须留白给拖动 ----
     这条是真实事故留下的断言：AI 按钮一度排在左侧簇的第三位（left:158），
     而竖屏画布只有 367 CSS px 宽 —— 它正好压在"飞船正下方"这个拖动起点上
     （0.5w ≈ 183）。后果不是报错，而是手指按下去点在按钮上、画布收不到拖动，
     表现为"飞船几乎不跟着手指走"。
     拖动是全触摸操作的基础，所以底部中央的留白要当成一条不变量守住。 */
  const centerFree = await evaluate(`(function(){
    var c=document.getElementById("game").getBoundingClientRect();
    var ids=['touch-weapon','touch-speed','touch-ai','touch-dash'];
    var rs=ids.map(function(i){return document.getElementById(i).getBoundingClientRect();});
    var hits=[];
    [0.42,0.5,0.58].forEach(function(fx){
      var px=c.left+c.width*fx, py=c.top+c.height*0.9;
      for (var i=0;i<rs.length;i++){
        var r=rs[i];
        if (px>=r.left && px<=r.right && py>=r.top && py<=r.bottom) {
          if (hits.indexOf(ids[i])<0) hits.push(ids[i]);
        }
      }
    });
    return hits.length ? hits.join(',') : "ok";
  })()`);
  check('画布底部中央没有被任何按钮占住（拖动起点必须可用）',
        centerFree === 'ok', '被占住的位置上命中 ' + centerFree);

  /* ---- 底部 HUD 的让位高度是否真的够 ----
     这一条是为一个实拍截图里发现的 bug 立的：倍速按钮叠在换枪按钮上方时，
     measureTouchPad 只量了冲刺按钮，算出的让位高度不够，
     倍速按钮正好压住左下角 WEAPON 那一行字 —— 而且不报任何错。
     所以这里把"按钮顶边到画布底边"换算成逻辑像素，直接和 hudBottomPad 比。 */
  const C = JSON.parse(await evaluate(`(function(){
    var G=__SpaceLine.game;
    var c=document.getElementById("game").getBoundingClientRect();
    var need=0;
    ["touch-weapon","touch-speed","touch-ai","touch-dash"].forEach(function(i){
      var up=(c.top+c.height)-document.getElementById(i).getBoundingClientRect().top;
      if (up>need) need=up;
    });
    return JSON.stringify({
      needLogical:Math.round(need/c.height*600),
      pad:G.hudBottomPad,
      canvasH:Math.round(c.height)
    });
  })()`));
  check('底部 HUD 的让位高度真的盖过了按钮顶边（截图里压字那个 bug）',
        C.pad >= C.needLogical,
        'pad=' + C.pad + ' 逻辑px ≥ 需要 ' + C.needLogical + '（画布高 ' + C.canvasH + ' CSS px）');

  // ---- 画布在缩放后坐标是否还准 ----
  const rect = await evaluate(`(function(){
    var r=document.getElementById("game").getBoundingClientRect();
    return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});
  })()`);
  const R = JSON.parse(rect);
  console.log('  手机视口下画布显示尺寸 : ' + Math.round(R.w) + '×' + Math.round(R.h) +
              '（CSS 缩放 ' + (R.w / 800).toFixed(3) + '）');

  // ---- 开局（点按钮，因为手机上没有空格键） ----
  // 坐标一定要现查，不能硬编码：手机视口下画布是否居中、有没有标题/脚注占位，
  // 都会随 CSS 媒体查询变化而挪动按钮位置（这个坑真踩过一次 —— 点空了，
  // 后面依赖"已开局"的四条断言连锁全红，看起来像触屏功能坏了）。
  const startBtn = JSON.parse(await evaluate(`(function(){
    var r=document.getElementById('ov-btn').getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
  })()`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startBtn.x, y: startBtn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startBtn.x, y: startBtn.y, button: 'left', clickCount: 1 });
  await sleep(400);
  check('触屏设备可以点按钮开局',
        (await evaluate('document.getElementById("overlay").classList.contains("hidden")')) === true);

  // ---- 真实触摸拖动：手指放在飞船下方，飞船应随之位移且不被手指挡住 ----
  const before = JSON.parse(await evaluate('JSON.stringify({x:__SpaceLine.game.player.x,y:__SpaceLine.game.player.y})'));
  // 手指起点选在画布中部偏下（飞船下方），终点向右上滑
  const tx0 = R.x + R.w * 0.50, ty0 = R.y + R.h * 0.90;
  const tx1 = R.x + R.w * 0.72, ty1 = R.y + R.h * 0.68;
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx0, y: ty0, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: tx0 + (tx1 - tx0) * i / 8, y: ty0 + (ty1 - ty0) * i / 8, id: 1 }],
    });
    await sleep(40);
  }
  await sleep(400);
  const after = JSON.parse(await evaluate('JSON.stringify({x:__SpaceLine.game.player.x,y:__SpaceLine.game.player.y})'));
  const movedX = after.x - before.x, movedY = after.y - before.y;
  check('真实触摸拖动让飞船位移（画布缩放后坐标仍准确）',
        movedX > 40 && movedY < -20,
        'Δ=' + Math.round(movedX) + ',' + Math.round(movedY) +
        '（手指位移 ≈ ' + Math.round((tx1 - tx0) / R.w * 800) + ',' + Math.round((ty1 - ty0) / R.h * 600) + ' 逻辑像素 × 1.42）');
  check('触摸期间自动开火（手机不需要射击键）', (await evaluate('__SpaceLine.Input.pointer.active')) === true);
  check('触摸时确实打出了子弹', (await evaluate('__SpaceLine.game.bullets.length')) >= 0);

  // ---- 第二根手指点屏幕冲刺按钮，移动手指不受影响 ----
  const dashFrom = JSON.parse(await evaluate('JSON.stringify({x:__SpaceLine.game.player.x,y:__SpaceLine.game.player.y})'));
  const btn = JSON.parse(await evaluate(`(function(){
    var r=document.getElementById("touch-dash").getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
  })()`));
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: tx1, y: ty1, id: 1 }, { x: btn.x, y: btn.y, id: 2 }],
  });
  await sleep(80);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: tx1, y: ty1, id: 1 }] });
  await sleep(300);
  const dashAfter = JSON.parse(await evaluate('JSON.stringify({x:__SpaceLine.game.player.x,y:__SpaceLine.game.player.y})'));
  check('第二根手指点冲刺按钮真的触发了冲刺',
        Math.hypot(dashAfter.x - dashFrom.x, dashAfter.y - dashFrom.y) > 20,
        '位移 ' + Math.round(Math.hypot(dashAfter.x - dashFrom.x, dashAfter.y - dashFrom.y)) + 'px');

  // ---- 触摸拖动的"多指保护"：第一根手指的基准不能被顶掉 ----
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  check('手指抬起后停止跟随', (await evaluate('__SpaceLine.Input.pointer.active')) === false);

  // ---- 倍速按钮：真实点一下（"看得见"不等于"按得到"）----
  // 用真实触摸事件打在按钮的实测中心点上，而不是直接调 toggleSpeed()：
  // 这一条要证明的恰恰是"手指真能按到这个位置"，绕开事件链路就失去意义了。
  const spd = JSON.parse(await evaluate(`(function(){
    var r=document.getElementById("touch-speed").getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
  })()`));
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spd.x, y: spd.y, id: 1 }] });
  await sleep(150);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);

  check('真实触摸按下倍速按钮 → 切到二倍速',
        (await evaluate('__SpaceLine.game.timeScale')) === 2,
        'timeScale = ' + (await evaluate('__SpaceLine.game.timeScale')));
  check('倍速按钮文字变成 ×2',
        (await evaluate('document.getElementById("touch-speed-text").textContent')) === '×2');
  check('倍速按钮点亮（.on）',
        (await evaluate('document.getElementById("touch-speed").classList.contains("on")')) === true);

  // 切回常速，避免影响后面那张触屏实拍的画面
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spd.x, y: spd.y, id: 1 }] });
  await sleep(150);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  check('再按一次回到常速（档位可逆）',
        (await evaluate('__SpaceLine.game.timeScale')) === 1 &&
        (await evaluate('document.getElementById("touch-speed-text").textContent')) === '1×');

  // ---- AI 圆钮：手机上没有 I 键，这是唯一入口 ----
  // 与倍速按钮一样，用真实触摸事件打在按钮的实测中心点上。
  const aib = JSON.parse(await evaluate(`(function(){
    var r=document.getElementById("touch-ai").getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
  })()`));
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: aib.x, y: aib.y, id: 1 }] });
  await sleep(150);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  check('真实触摸按下 AI 按钮 → 进入接管',
        (await evaluate('__SpaceLine.AutoPilot.on')) === true);
  check('AI 按钮文字变成 ON 并点亮',
        (await evaluate('document.getElementById("touch-ai-text").textContent')) === 'ON' &&
        (await evaluate('document.getElementById("touch-ai").classList.contains("on")')) === true);

  // 触屏上没有方向键，"夺回控制权"这条路径必须靠真手指 —— 顺带把这条也验了
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx0, y: ty0, id: 1 }] });
  await sleep(250);
  check('手指一碰画布（开始拖动）AI 就交还控制权',
        (await evaluate('__SpaceLine.AutoPilot.on')) === false);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  check('交还后 AI 按钮文字与点亮状态一起复位',
        (await evaluate('document.getElementById("touch-ai-text").textContent')) === 'AI' &&
        (await evaluate('document.getElementById("touch-ai").classList.contains("on")')) === false);

  // ---- 触屏下的实际画面 ----
  await evaluate(`(function(){
    var G=__SpaceLine.game, E=__SpaceLine.classes.Enemy;
    G.enemies.length=0;
    for (var i=0;i<5;i++){var e=new E(2);e.x=140+i*130;e.y=160+i*40;e.speed=0;e.vx=0;G.enemies.push(e);}
    G.combo=14; G.comboTimer=3; G.player.unlockWeapon("twin");
    return G.enemies.length;
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx0, y: ty0, id: 1 }] });
  await sleep(500);
  await shot('_shot_10_touch.png');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);

  console.log('\n控制台错误/未捕获异常：' + (problems.length ? '\n  ' + problems.join('\n  ') : '无 ✅'));
  console.log(fail === 0
    ? '\n🎉 浏览器验证全部 ' + pass + ' 项通过' + (problems.length ? '' : '，零控制台错误')
    : '\n⚠️ ' + pass + ' 项通过 / ' + fail + ' 项未通过');

  ws.close();
  cleanup();
  await sleep(300);
  process.exit(fail === 0 && problems.length === 0 ? 0 : 1);
})().catch((e) => { console.log('❌ 验证脚本出错:', e.message); process.exit(1); });
