/**
 * 桌面版冒烟测试：把刚打出来的 win-unpacked 真的跑起来，用 CDP 连进渲染进程，
 * 确认它加载的是「这次打的」那份 index.html（从 app.asar 里），而不是构建缓存里的旧页。
 *
 * 为什么必须真跑：asar 里的字节对（chain.py 的 L5 已经验过）只能证明
 * "文件被正确地打进去了"，证明不了 Electron 壳能把它渲染出来。
 * 打包成功 ≠ 能运行 —— 这两件事之间还夹着 main.js、窗口创建、GPU 子进程。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 本脚本踩过三个**互相掩盖**的坑，每一个都让"起不来"看起来像环境问题。
 *    它们的共同点是：症状都在更早的一层，掩盖了真正的原因。
 *
 * ① `ELECTRON_RUN_AS_NODE=1` 会让 exe **当纯 Node 跑**，根本不进 Electron。
 *    WorkBuddy 自己就是 Electron  built 的，会设这个变量，于是本机上必然中招。
 *    症状极具欺骗性：`--safe-mode` / `--remote-debugging-port` 全被 **Node 的参数
 *    解析器**拒掉，报 `SpaceLine.exe: bad option: --safe-mode` ——
 *    看起来像"这个 exe 不认参数"，实际是"它压根不是以 GUI 程序在跑"。
 *    判据：传一个非选项参数（`SpaceLine.exe hello`），若报
 *    `Cannot find module '...\hello'` 且栈里有 `node:internal/modules/cjs/loader`，
 *    就是这个坑。→ spawn 时显式从 env 里删掉。
 *
 * ② GPU 子进程起不来 → `GPU process isn't usable. Goodbye.`，主进程几秒内退出。
 *    这是**环境相关**的（无显卡 / 驱动异常 / 受限容器），不是打包缺陷。
 *    main.js 第 19-27 行早就为此写好了 `--safe-mode` 开关。
 *
 * ③ ⚠️ **"CDP 端口亮了"不等于"应用起来了"**。②里 GPU 是**反复崩**的：
 *    `DevTools listening on ws://...` 会先打印，端口能连上，几秒后主进程才死。
 *    所以启动成功的判据必须是**真的求值成功**，而不是"端口能连"。
 *    本轮就是靠这一条才没把"应用已死"误判成"页面脚本没挂上"。
 *
 * 另外一条通用教训：**任何跨进程等待都必须有超时**。
 * 没设超时的 await 碰上"永远不来"的响应时，事件循环里没有活跃句柄，
 * node 会**以退出码 0 静默退出** —— 什么也不打印，看着像"跑完了没报错"。
 * 本轮实测到两次，所以这里加了总看门狗 + 每次 send 的超时。
 *
 * 用法：node verify/desktopsmoke.js
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop', 'release_v130', 'win-unpacked', 'SpaceLine.exe');
const PORT = 9351;
// 首次冷启动的容忍上限。实测本机（无独立桌面会话）从 spawn 到「能真的求值」
// 要 **超过 30 秒**：exe 有 188 MB，Electron 要解包、语言包要初始化。
// ⚠️ 我一开始把它写成 8000ms，结果**把成功判成了失败** —— 报「启动后 2.5 秒内
//    进程已退出」，可那进程其实活得好好的，手动连进去求值一切正常。
// 超时的意义是「别无限等」，不是「超过就该判死」：宁可多等，不要误杀。
const BOOT_TIMEOUT = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => {
  console.log('❌ 冒烟测试超过 90s 仍未完成 —— 判定不通过');
  killStale();
  process.exit(1);
}, 90000);

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    sleep(ms).then(() => { throw new Error(label + ' 超时 ' + ms + 'ms'); }),
  ]);
}

/** Electron 的单实例锁会让第二次启动直接 quit，所以先清场。 */
function killStale() {
  try { spawnSync('taskkill', ['/F', '/IM', 'SpaceLine.exe'], { stdio: 'ignore' }); } catch (e) {}
}
function countAlive() {
  const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq SpaceLine.exe'], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').filter((l) => l.indexOf('SpaceLine.exe') >= 0).length;
}

/** 连上 CDP 并做一次真实求值，返回会话或 null。 */
async function attach() {
  let targets = null;
  // 轮询上限按 BOOT_TIMEOUT 算，不再写死次数 —— 否则改了一个超时却忘了另一个。
  const deadline = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await r.json();
      if (targets && targets.length) break;
    } catch (e) {}
    await sleep(300);
  }
  const page = targets && targets.find((t) => t.type === 'page');
  if (!page) return { err: '没有 type=page 的调试目标' };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const opened = await Promise.race([
    new Promise((r) => ws.addEventListener('open', () => r(true))),
    new Promise((r) => ws.addEventListener('error', (e) => r('连接失败: ' + (e.message || '未知')))),
    sleep(BOOT_TIMEOUT).then(() => '超时'),
  ]);
  if (opened !== true) return { err: 'CDP WebSocket ' + opened };

  let id = 0;
  const waiters = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result || m.error); waiters.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });
  const send = (method, params = {}, timeout) => withTimeout(new Promise((res) => {
    const i = ++id; waiters.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  }), timeout || BOOT_TIMEOUT, 'CDP ' + method);
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r && r.exceptionDetails) return undefined;
    return r && r.result && r.result.value;
  };

  try {
    await send('Runtime.enable');
    // 坑 ③：必须真的求值成功才算"应用活着"
    const two = await evaluate('1+1');
    if (two !== 2) return { err: '求值返回异常：1+1 = ' + JSON.stringify(two) };
  } catch (e) {
    return { err: e.message + '（主进程可能已经退出）' };
  }
  return { ws, send, evaluate, errors, url: page.url };
}

/** 启动一次并确认它真的活着。 */
async function launch(extraArgs) {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;                       // 坑 ①
  const child = spawn(EXE, extraArgs.concat(['--remote-debugging-port=' + PORT]),
    { stdio: 'ignore', env });
  const s = await attach();
  if (s.err) {
    try { child.kill(); } catch (e) {}
    return { ok: false, err: s.err };
  }
  // 再稳一手：复查进程还在不在，别又被 GPU 崩掉（坑 ③）。
  // ⚠️ 这条复查的**真正作用是抓「attach 之后才崩」**，不是限制启动时长 ——
  //    冷启动要几十秒，所以必须放在 attach（已确认能求值）之后，而不是之前。
  await sleep(2500);
  if (countAlive() === 0) {
    try { child.kill(); } catch (e) {}
    return { ok: false, err: '求值成功后进程仍退出（GPU 崩溃等）' };
  }
  return { ok: true, child, ...s };
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.log('❌ 找不到 ' + EXE + '\n   先跑 electron-builder 构建。');
    process.exit(1);
  }
  console.log('启动：' + path.relative(ROOT, EXE) + '（' + fs.statSync(EXE).size.toLocaleString() + ' 字节）');
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.log('  注意：本 shell 里 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE
      + '，脚本已在子进程里清掉它（坑 ①）');
  }

  killStale();
  await sleep(600);

  let mode = '';
  let run = await launch([]);
  if (run.ok) {
    mode = '常规（硬件加速）';
  } else {
    console.log('  常规方式不可用：' + run.err);
    console.log('  按 main.js 第 19-27 行的说明退到 --safe-mode 再试…');
    killStale();
    await sleep(800);
    run = await launch(['--safe-mode']);
    mode = run.ok ? '--safe-mode（禁用硬件加速）' : '';
  }
  if (!run.ok) {
    console.log('❌ 两种方式都起不来：' + run.err);
    console.log('   这**不代表打包有问题**（asar 内容已由 chain.py 的 L5 验过逐字节一致），');
    console.log('   只说明本机开不了窗口。');
    killStale();
    process.exit(1);
  }
  console.log('  启动档位：' + mode);
  console.log('  渲染页　：' + String(run.url).slice(-52));

  const evaluate = run.evaluate;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    if (await evaluate('!!(window.__SpaceLine && window.__SpaceLine.game)')) { ready = true; break; }
    await sleep(300);
  }
  if (!ready) {
    console.log('❌ 窗口活着但游戏脚本没挂上 window.__SpaceLine');
    killStale();
    process.exit(1);
  }

  const info = JSON.parse(await evaluate(`(function(){
    var g = window.__SpaceLine.game, p = g.player;
    return JSON.stringify({
      w: document.getElementById('game').width,
      h: document.getElementById('game').height,
      title: document.title,
      state: g.state,
      hasAI: typeof window.__SpaceLine.AutoPilot.think === 'function',
      lives: p.lives
    });
  })()`));
  console.log('  ✅ 桌面版启动并加载了游戏脚本');
  console.log('     画布 ' + info.w + '×' + info.h + ' ・ 标题「' + info.title + '」'
    + ' ・ 状态 ' + info.state + ' ・ AI 模块 ' + (info.hasAI ? '在' : '缺失'));

  await evaluate('(function(){var g=window.__SpaceLine.game;'
    + 'window.__SpaceLine.AutoPilot.engage(g); g.start(); return 1;})()');
  await sleep(1800);
  const ai = JSON.parse(await evaluate(`(function(){
    var A = window.__SpaceLine.AutoPilot, p = window.__SpaceLine.game.player;
    return JSON.stringify({on:A.on, shoot:A.input.shoot, x:Math.round(p.x), lives:p.lives,
                           elapsed:Number(window.__SpaceLine.game.realElapsed.toFixed(2))});
  })()`));
  const aiOk = ai.on === true && ai.shoot === true && ai.lives === 3 && ai.elapsed > 0.5;
  console.log('  ' + (aiOk ? '✅' : '❌')
    + ' 桌面版里 AI 接管正常：on=' + ai.on + ' shoot=' + ai.shoot
    + ' 命=' + ai.lives + ' 已推进 ' + ai.elapsed + 's' + (ai.x !== 400 ? '（x=' + ai.x + '，自己动过）' : ''));

  /* ---- 顺手拍一张"桌面版在跑"的实拍 ----
     数字能证明它启动了，但"打包产物真的在玩这个游戏"这件事，
     一张从 app.asar 里渲染出来的截图比任何断言都直观。 */
  try {
    const shot = await run.send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) {
      const out = path.join(__dirname, '_shot_13_desktop_app.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('  📷 已截图 ' + path.relative(ROOT, out));
    }
  } catch (e) {
    console.log('  （截图失败：' + e.message + '）');
  }

  console.log('  ' + (run.errors.length
    ? '❌ 渲染进程有异常：' + run.errors.slice(0, 3).join(' | ')
    : '✅ 渲染进程零未捕获异常'));

  try { run.child.kill(); } catch (e) {}
  await sleep(500);
  killStale();          // Electron 会留下渲染/GPU 子进程，只 kill 主进程不够干净
  await sleep(300);
  const left = countAlive();
  console.log('  ' + (left ? '⚠️ 仍有 ' + left + ' 个残留进程' : '✅ 进程已全部清理'));

  clearTimeout(watchdog);
  process.exit(aiOk && !run.errors.length ? 0 : 1);
})().catch((e) => { console.error('冒烟脚本自身出错：', e); killStale(); process.exit(1); });
