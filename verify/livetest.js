/**
 * 公网地址验证：真的打开 GitHub Pages 上那份，玩一遍。
 *
 * 为什么哈希一致了还要再跑一次真浏览器：
 *   `curl` 比哈希只能证明「服务器吐给我的字节是对的」，证明不了
 *   「浏览器拿到这些字节后能跑起来」。两者之间还夹着好几层：
 *     - 响应头（Content-Type、CSP、X-Content-Type-Options）
 *     - 缓存 / Service Worker 是否把旧版本喂给了浏览器
 *     - HTTPS 下 localStorage 是否可用（排行榜依赖它，file:// 下行为不同）
 *   这些只有真浏览器才知道。所以这一层是 L5，不是重复劳动。
 *
 * 顺带做一个独立交叉验证：让**浏览器自己** fetch 一次 index.html 并用
 * crypto.subtle 算 SHA-256，再和 Node 侧算的本地哈希比。这样连
 * 「curl 和浏览器的网络路径不同，看到的可能不是同一份」这个疑点也一起排掉了。
 *
 * 用法：node verify/livetest.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9344;
const CWD = __dirname;
const ROOT = path.join(__dirname, '..');
const LIVE_URL = 'https://kevin0521-wjw.github.io/space-line/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  ' + extra : ''));
  if (ok) pass++; else fail++;
};
const info = (label, val) => console.log('     · ' + label + ': ' + val);

(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(CWD, '_edgeprofile_live'),
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
      const e = msg.params.entry;
      // ⚠️ 关键：Log.entryAdded 里，出错的资源 URL 在 `entry.url`，**不在** `entry.text`。
      //    text 只有一句「Failed to load resource: the server responded with a status of 404 ()」，
      //    光看 text 根本分不清 404 的是 favicon 还是游戏本体 —— 过滤必须读 url 字段。
      const where = String(e.url || '') + ' ' + String(e.text || '');
      // favicon.ico 在 Pages 上没有，必然 404 —— 与游戏无关，单独放行。
      // 用「favicon」判定而不是用「404」判定，免得把真正的资源 404 也一起吞掉。
      if (/favicon/i.test(where)) return;
      problems.push('日志错误: ' + (e.url ? e.url + ' → ' : '') + (e.text || ''));
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; waiters.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr, opts = {}) => {
    const r = await send('Runtime.evaluate', Object.assign({ expression: expr, returnByValue: true, awaitPromise: true }, opts));
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
  await send('Log.enable');

  console.log('打开公网地址：' + LIVE_URL);
  await send('Page.navigate', { url: LIVE_URL });

  // 公网首次加载比 file:// 慢，给足时间
  for (let i = 0; i < 60; i++) {
    if ((await evaluate('document.readyState')) === 'complete') break;
    await sleep(250);
  }
  await sleep(1200);

  // ---- 1) 页面真的到了正确的地址，且不是错误页 ----
  const loc = await evaluate('location.href');
  check('浏览器实际落在公网地址上', String(loc).startsWith(LIVE_URL), loc);
  check('不是 GitHub Pages 的 404 页',
        (await evaluate('!/404|There isn\'t a GitHub Pages site here/i.test(document.body.innerText)')) === true);

  // ---- 2) 响应头（哈希比对看不到的那一层）----
  const ct = await evaluate(
    "fetch(location.href,{cache:'no-store'}).then(function(r){return r.status+' | '+r.headers.get('content-type');})",
  );
  info('响应', ct);
  check('返回 200 且 Content-Type 是 text/html',
        /^200 \| text\/html/.test(String(ct)), String(ct));

  // ---- 3) 浏览器侧独立算哈希，与 Node 侧算的本地哈希比 ----
  const toolHash = await evaluate(`(async function(){
    try {
      var r = await fetch('index.html', {cache:'no-store'});
      var buf = await r.arrayBuffer();
      var d = await crypto.subtle.digest('SHA-256', buf);
      var b = new Uint8Array(d), s = '';
      for (var i = 0; i < b.length; i++) s += ('0'+b[i].toString(16)).slice(-2);
      return s + '|' + buf.byteLength;
    } catch (e) { return 'ERR:' + e.message; }
  })()`);
  const [liveHash, liveLen] = String(toolHash).split('|');
  const localBuf = fs.readFileSync(path.join(ROOT, 'index.html'));
  const localHash = crypto.createHash('sha256').update(localBuf).digest('hex');
  info('浏览器算出的线上哈希', liveHash);
  info('Node 算出的本地哈希', localHash);
  check('浏览器拿到的字节与本地源逐字节一致（独立于 curl 的路径）',
        liveHash === localHash && Number(liveLen) === localBuf.length,
        liveLen + ' 字节');

  // ---- 4) 游戏本体真的能被这个地址加载起来 ----
  check('页面里游戏脚本跑起来了（钩子存在）',
        (await evaluate('!!(window.__SpaceLine && window.__SpaceLine.game)')) === true);
  check('画布逻辑分辨率固定 800×600',
        (await evaluate('(function(){var c=document.getElementById("game");return c.width+"x"+c.height;})()')) === '800x600');
  check('开场界面标题正确',
        (await evaluate('document.getElementById("ov-title").textContent')) === '星 际 防 线');

  // ---- 5) HTTPS 下 localStorage 可用（排行榜依赖它，file:// 下行为不一样）----
  check('HTTPS 下 localStorage 可读写（排行榜能存）',
        (await evaluate(
          "(function(){try{localStorage.setItem('__t','1');var ok=localStorage.getItem('__t')==='1';localStorage.removeItem('__t');return ok;}catch(e){return 'ERR:'+e.message;}})()",
        )) === true);

  // ---- 6) 真的开一局并推进 ----
  await key('keyDown', ' ', 'Space', 32);
  await key('keyUp', ' ', 'Space', 32);
  await sleep(500);
  check('空格能从公网页面开局',
        (await evaluate('document.getElementById("overlay").classList.contains("hidden")')) === true);

  const t0 = await evaluate('__SpaceLine.game.elapsed');
  await key('keyDown', 'ArrowLeft', 'ArrowLeft', 37);
  await sleep(1400);
  await key('keyUp', 'ArrowLeft', 'ArrowLeft', 37);
  const g = await evaluate(`(function(){
    var G = __SpaceLine.game;
    return JSON.stringify({elapsed:G.elapsed, enemies:G.enemies.length, level:G.level, state:G.state});
  })()`);
  info('运行中状态', g);
  const st = JSON.parse(g);
  check('主循环在推进（elapsed 增长）', st.elapsed > t0, t0.toFixed(2) + 's → ' + Number(st.elapsed).toFixed(2) + 's');
  check('敌人正常刷新', st.enemies > 0, st.enemies + ' 个');
  check('帧率正常（不是被节流的假运行）', st.elapsed - t0 > 1.0, '1.4s 墙钟内推进 ' + (st.elapsed - t0).toFixed(2) + 's');

  // ---- 6.5) AI 自动模式在这个地址上真的能用（哈希相同 ≠ 功能可用）----
  //   本轮上线的新功能就是它，所以单独验一次：钩子挂着、按 I 能接管、
  //   接管后确实自己在开火和走位、人一按键立刻交还。
  //   注意与 selftest 的分工：那边用「无 AI 必掉命」的对照组证明躲弹质量，
  //   这里只证明「线上这份确实带着这个功能且能跑」。
  check('公网页面上挂着 AI 自动模式的钩子',
        (await evaluate('!!(window.__SpaceLine && window.__SpaceLine.AutoPilot)')) === true);

  /* ---- 证明线上跑的是「修好导航与冲刺」那一份，而不只是"带 AI 的旧版" ----
     字节相同只能证明发对了文件，证明不了线上那份里真的有这轮改的逻辑。
     这里挑两个**确定性**的标志物（不依赖随机局面）：
       ① 导航用的 _urgent() 方法存在；
       ② 冲刺的"赶路"参数 DASH_RUSH 已就位。
     刻意不写"AI 在 N 秒内一定按了 shift"这种断言 —— 那是概率事件，
     拿它当断言就是给自己埋一个偶发红灯。 */
  const aiFix = JSON.parse(await evaluate(`(function(){
    var A = __SpaceLine.AutoPilot, C = __SpaceLine.CFG.AI;
    return JSON.stringify({urgent: typeof A._urgent, dashRush: C.DASH_RUSH,
                           leakSave: C.LEAK_SAVE, bodyMax: C.BODY_MAX});
  })()`));
  check('线上这一份含修好的导航逻辑（_urgent 存在）', aiFix.urgent === 'function',
        '_urgent = ' + aiFix.urgent);
  check('线上这一份含冲刺赶路与贴脸威胁参数',
        aiFix.dashRush > 0 && aiFix.leakSave > 0 && aiFix.bodyMax > 1,
        'DASH_RUSH=' + aiFix.dashRush + ' LEAK_SAVE=' + aiFix.leakSave
        + ' BODY_MAX=' + aiFix.bodyMax);

  const aiBefore = JSON.parse(await evaluate(`(function(){
    var p = __SpaceLine.game.player;
    return JSON.stringify({x:Math.round(p.x), y:Math.round(p.y), lives:p.lives});
  })()`));
  await key('keyDown', 'i', 'KeyI', 73);
  await key('keyUp', 'i', 'KeyI', 73);
  await sleep(1300);
  const aiState = await evaluate(`(function(){
    var A = __SpaceLine.AutoPilot, p = __SpaceLine.game.player;
    return JSON.stringify({on:A.on, shoot:A.input.shoot, x:Math.round(p.x), y:Math.round(p.y), lives:p.lives});
  })()`);
  info('AI 接管状态', aiState);
  const ai = JSON.parse(aiState);
  check('按 I 后 AI 在公网页面上接管', ai.on === true, aiState);
  check('AI 接管时自己在开火（全程没按过空格）', ai.shoot === true, aiState);
  check('AI 接管后飞船真的在自己走位',
        Math.abs(ai.x - aiBefore.x) > 5 || Math.abs(ai.y - aiBefore.y) > 5,
        '(' + aiBefore.x + ',' + aiBefore.y + ') → (' + ai.x + ',' + ai.y + ')');
  check('AI 接管这段时间没在挨打（命数没掉）', ai.lives >= aiBefore.lives,
        aiBefore.lives + ' → ' + ai.lives);

  await key('keyDown', 'd', 'KeyD', 68);
  await sleep(250);
  const aiAfter = await evaluate('__SpaceLine.AutoPilot.on');
  check('真人一按键立刻夺回控制权', aiAfter === false, 'on = ' + aiAfter);
  await key('keyUp', 'd', 'KeyD', 68);
  await sleep(150);

  // ---- 7) 排行榜写入路径（走真实的 localStorage，不是桩）----
  const board = await evaluate(`(function(){
    try {
      var G = __SpaceLine.game;
      G.score = 12345; G.level = 7; G.elapsed = 88.5;
      G.gameOver();
      var raw = localStorage.getItem('space-line-scores');
      return raw ? raw.slice(0, 160) : '(空)';
    } catch (e) { return 'ERR:' + e.message; }
  })()`);
  info('排行榜存档', board);
  check('排行榜能真实写进 localStorage', /12345/.test(String(board)), String(board));

  // ---- 8) 控制台必须干净 ----
  check('全程零控制台错误', problems.length === 0,
        problems.length ? '\n        ' + problems.slice(0, 5).join('\n        ') : '');

  try { proc.kill(); } catch (e) {}
  try { fs.rmSync(path.join(CWD, '_edgeprofile_live'), { recursive: true, force: true }); } catch (e) {}

  console.log(fail === 0
    ? '\n🎉 公网地址验证 ' + pass + ' 项全通过'
    : '\n⚠️ ' + pass + ' 项通过 / ' + fail + ' 项未通过');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身出错:', e);
  process.exit(1);
});
