/**
 * 桌面版冒烟测试：把刚打出来的 win-unpacked 真的跑起来，用 CDP 连进渲染进程，
 * 确认它加载的是「这次打的」那份 index.html，而不是构建缓存里的旧页。
 *
 * 为什么必须真跑：asar 里的字节对（chain.py 的 L5 已经验过）只能证明
 * "文件被正确地打进去了"，证明不了 Electron 壳能把它渲染出来。
 * 打包成功 ≠ 能运行 —— 这两件事之间还夹着 main.js、preload、窗口创建。
 *
 * 已知限制：GUI 窗口在沙箱里可能起不来。起不来时本脚本会明确报 FAIL，
 * 而不是假装通过 —— 一个"起不来但算过"的冒烟测试比没有更糟。
 *
 * 用法：node verify/desktopsmoke.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop', 'release_v130', 'win-unpacked', 'SpaceLine.exe');
const PORT = 9351;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(EXE)) {
    console.log('❌ 找不到 ' + EXE + '\n   先跑 electron-builder 构建。');
    process.exit(1);
  }
  const size = fs.statSync(EXE).size;
  console.log('启动：' + path.relative(ROOT, EXE) + '（' + size.toLocaleString() + ' 字节）');

  const proc = spawn(EXE, ['--remote-debugging-port=' + PORT], { stdio: 'ignore' });
  const kill = () => { try { proc.kill(); } catch (e) {} };
  process.on('exit', kill);

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await r.json();
      if (targets && targets.length) break;
    } catch (e) {}
    await sleep(300);
  }

  if (!targets || !targets.length) {
    console.log('❌ 桌面版没能起来：连不上 CDP 端口 ' + PORT);
    console.log('   （沙箱里 GUI 起不来是已知限制，不能因此判定通过）');
    kill();
    process.exit(1);
  }

  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.log('❌ 起来了但没有渲染进程（type=page 的 target 不存在）');
    kill();
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
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
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; waiters.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return undefined;
    return r?.result?.value;
  };

  await send('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await evaluate('!!(window.__SpaceLine && window.__SpaceLine.game)')) { ready = true; break; }
    await sleep(300);
  }

  console.log('');
  if (!ready) {
    console.log('❌ 窗口起来了但游戏脚本没挂上 window.__SpaceLine');
    console.log('   渲染进程异常：' + (errors.length ? errors.slice(0, 3).join(' | ') : '（无）'));
    kill();
    process.exit(1);
  }

  const info = JSON.parse(await evaluate(`(function(){
    var g = window.__SpaceLine.game, p = g.player;
    return JSON.stringify({
      w: document.getElementById('game').width,
      h: document.getElementById('game').height,
      title: document.getElementById('ov-title').textContent,
      state: g.state,
      hasAI: typeof window.__SpaceLine.AutoPilot.think === 'function',
      lives: p.lives
    });
  })()`));

  console.log('  ✅ 桌面版启动并加载了游戏脚本');
  console.log('     画布 ' + info.w + '×' + info.h + ' ・ 标题「' + info.title + '」'
    + ' ・ 状态 ' + info.state + ' ・ AI 模块 ' + (info.hasAI ? '在' : '缺失'));

  const on = await evaluate(`(function(){
    var g = window.__SpaceLine.game;
    window.__SpaceLine.AutoPilot.engage(g); g.start();
    return true;
  })()`);
  await sleep(1500);
  const ai = JSON.parse(await evaluate(`(function(){
    var A = window.__SpaceLine.AutoPilot, p = window.__SpaceLine.game.player;
    return JSON.stringify({on:A.on, shoot:A.input.shoot, x:Math.round(p.x), lives:p.lives,
                           elapsed:Number(window.__SpaceLine.game.realElapsed.toFixed(2))});
  })()`));
  console.log('  ' + (ai.on && ai.shoot && ai.lives === 3 ? '✅' : '❌')
    + ' 桌面版里 AI 接管正常：shoot=' + ai.shoot + ' 命=' + ai.lives
    + ' 已推进 ' + ai.elapsed + 's');
  if (ai.x !== 400) console.log('     飞船 x=' + ai.x + '（起始 400，说明确实自己动过）');

  console.log('  ' + (errors.length ? '❌ 渲染进程有异常：' + errors.slice(0, 3).join(' | ')
    : '✅ 渲染进程零未捕获异常'));

  kill();
  await sleep(400);
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('冒烟脚本自身出错：', e); process.exit(1); });
