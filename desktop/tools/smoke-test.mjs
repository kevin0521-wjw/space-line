/**
 * 桌面端冒烟测试：把 Electron 应用真启动起来，用 CDP 连进渲染进程做断言。
 *
 * 为什么不能只做静态检查：窗口尺寸算错、localStorage 在 file:// 下不可用、
 * 主进程起来了但渲染进程被沙箱干掉 —— 这些只有真跑一次才知道。
 *
 * 用法：
 *   node tools/smoke-test.mjs                                    # 测开发版（node_modules 里的 electron）
 *   node tools/smoke-test.mjs release/win-unpacked/SpaceLine.exe # 测打包后的 exe
 *
 * 注意：需要能 spawn GUI 进程，受限沙箱下要用 dangerouslyDisableSandbox 执行。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..');

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(target)) {
  console.log('❌ 找不到可执行文件：' + target);
  process.exit(1);
}

// 判断是"未打包的 electron.exe"还是"已打包的应用 exe" —— 两者的参数不同：
// 前者需要额外传入 app 目录，后者自己就是应用
const isBareElectron = /[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i.test(target);

const CDP_PORT = 9400 + (process.pid % 300);   // 随机端口，避免与其它调试会话抢
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceline-smoke-'));

const env = { ...process.env };
// ⭐ 这两条是硬要求：
//   ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成 Node REPL —— 没有窗口、没有 CDP 端口，
//   而且不报任何错，表现为"启动后毫无反应"（部分宿主/沙箱环境会预设这个变量）；
//   NODE_OPTIONS 里宿主注入的 shim 会 patch http/https，污染 GUI 进程的网络行为。
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const switches = [
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profile,
];
const args = isBareElectron ? [APP_DIR, ...switches] : switches;

console.log('启动: ' + target);
console.log('模式: ' + (isBareElectron ? '开发版（未打包）' : '打包版 exe'));
console.log('CDP : 127.0.0.1:' + CDP_PORT + '\n');

const child = spawn(target, args, { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });

let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
child.on('error', (e) => console.log('❌ 进程启动失败: ' + e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 收尾：按 PID 杀整棵进程树，再按镜像名兜底（渲染进程有时不在主进程树下） */
function cleanup() {
  try { spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (e) {}
  const img = path.basename(target);
  try { spawnSync('taskkill', ['/f', '/im', img], { stdio: 'ignore' }); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanup);

let fail = 0;
const check = (label, ok, extra = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  ' + extra : ''));
  if (!ok) fail++;
};

(async () => {
  // ---- 1) 等 CDP 端口（轮询而不是固定 sleep：窗口生命周期在受限环境下可能很短）----
  let page = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  if (!page) {
    console.log('❌ 60 次轮询后仍未拿到 page target');
    if (stderrBuf) console.log('--- 进程 stderr ---\n' + stderrBuf.slice(0, 1200));
    process.exit(1);
  }
  check('CDP 拿到 page target', true, JSON.stringify(page.title));

  // ---- 2) 连 WebSocket，实现带超时的 id→Promise ----
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  let msgId = 0;
  const waiters = new Map();
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      problems.push('异常: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      problems.push('console.error: ' + JSON.stringify(m.params.args.map((a) => a.value ?? a.description)));
    }
  });

  // ⭐ 每个请求都必须带超时：渲染进程若已死，未响应的 await 会永远挂着，
  //   最后只看到 "unsettled top-level await"，完全看不到真实原因
  const send = (method, params = {}, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error('CDP 超时(' + timeoutMs + 'ms): ' + method));
    }, timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.error) throw new Error('CDP 错误: ' + JSON.stringify(r.error));
    const res = r.result || {};
    // ⭐ 必须显式检查 exceptionDetails：页面里求值抛错时 CDP 返回的是 200 + 空 value，
    //   不检查就会拿到 undefined，最后报一个跟真实原因毫无关系的 "undefined is not valid JSON"
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('页面求值抛错: ' + (d.exception?.description || d.text || JSON.stringify(d)));
    }
    return res.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // ---- 等页面真正可用（轮询，别用固定 sleep）----
  // 注意条件不能只看 readyState：file:// 下它变 complete 与画布元素可读之间仍有一个极短的窗口，
  // 只看 readyState 会偶发地读到 null（我第一次跑打包版就踩到了，表现为莫名其妙的 JSON 解析错误）。
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const ok = await evaluate('document.readyState === "complete" && !!document.getElementById("game")');
    if (ok) { ready = true; break; }
    await sleep(200);
  }
  check('页面加载完成且画布元素就位', ready);

  // 页面到底加载了什么：打包后路径写错时最典型的症状是"就绪了但没有游戏画布"
  console.log('   location: ' + (await evaluate('location.href')));
  console.log('   标题    : ' + JSON.stringify(await evaluate('document.title')));
  console.log('   元素数  : ' + (await evaluate('document.querySelectorAll("*").length')));
  check('页面里存在游戏画布', (await evaluate('!!document.getElementById("game")')) === true);

  // ---- 4) 布局与页面基本断言 ----
  const layout = await evaluate(`(() => {
    const c = document.getElementById('game');
    const r = c.getBoundingClientRect();
    const ov = document.getElementById('overlay');
    return JSON.stringify({
      title: document.title,
      inner: window.innerWidth + 'x' + window.innerHeight,
      attr: c.width + 'x' + c.height,
      css: Math.round(r.width) + 'x' + Math.round(r.height),
      ovVisible: !ov.classList.contains('hidden'),
      ovTitle: document.getElementById('ov-title').textContent,
      btn: document.getElementById('ov-btn').textContent,
    });
  })()`);
  const L = JSON.parse(layout);
  console.log('   页面信息: ' + layout);
  check('窗口标题正确', L.title.indexOf('星际防线') >= 0);
  check('画布逻辑分辨率 = 800x600', L.attr === '800x600');
  check('画布实际显示尺寸 = 800x600（窗口尺寸计算无误）', L.css === '800x600', '窗口内容区 ' + L.inner);
  check('开场覆盖层可见且文案正确', L.ovVisible && L.ovTitle === '星 际 防 线' && L.btn === '开始游戏');

  // ---- 5) file:// 下 localStorage 是否可用（最高分能不能存住）----
  const lsOk = await evaluate(`(() => {
    try {
      localStorage.setItem('__probe__', 'ok');
      const v = localStorage.getItem('__probe__');
      localStorage.removeItem('__probe__');
      return v === 'ok';
    } catch (e) { return false; }
  })()`);
  check('localStorage 可用（最高分能持久化）', lsOk === true);

  // 可选：SPACELINE_SHOT_MENU=<路径> 时，只截一张开场图就退出。
  // 为什么单独一个分支：实测发现先 captureScreenshot 再派发输入事件，
  // 第二次 Input.dispatchKeyEvent 会永久卡死（软件渲染下截图会拖住 compositor）。
  // 所以"截图"和"输入断言"必须分开两趟跑，不能混在同一次会话里。
  if (process.env.SPACELINE_SHOT_MENU) {
    const r = await send('Page.captureScreenshot', { format: 'png' }, 20000);
    fs.writeFileSync(process.env.SPACELINE_SHOT_MENU, Buffer.from(r.result.data, 'base64'));
    console.log('   📷 ' + process.env.SPACELINE_SHOT_MENU + '（仅截图模式，跳过输入测试）');
    ws.close();
    cleanup();
    await sleep(400);
    console.log('\n🎉 已截取开场界面');
    process.exit(0);
  }

  // ---- 6) 真按键：空格开局 → 覆盖层隐藏 ----
  // 输入事件给 20s 超时：安全模式下是软件渲染，截图/首帧合成偶尔会让渲染线程忙上一两秒，
  // 用默认的 8s 会偶发地误判成"进程死了"（踩过一次）
  const key = (type, k, code, vk) => send('Input.dispatchKeyEvent', {
    type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  }, 20000);
  await key('keyDown', ' ', 'Space', 32);
  await key('keyUp', ' ', 'Space', 32);
  await sleep(400);
  const started = await evaluate(`document.getElementById('overlay').classList.contains('hidden')`);
  check('按空格后游戏开始（覆盖层隐藏）', started === true);

  // ---- 7) 模拟一段真实游玩：持续开火 + 移动 ----
  for (let i = 0; i < 8; i++) {
    await key('keyDown', ' ', 'Space', 32);
    const dir = i % 2 ? ['ArrowLeft', 37] : ['ArrowRight', 39];
    await key('keyDown', dir[0], dir[0], dir[1]);
    await key('keyUp', i % 2 ? 'ArrowRight' : 'ArrowLeft', i % 2 ? 'ArrowRight' : 'ArrowLeft', i % 2 ? 39 : 37);
    await sleep(150);
  }
  const stillHidden = await evaluate(`document.getElementById('overlay').classList.contains('hidden')`);
  check('连续 1.2 秒游玩后仍在进行中（未崩溃）', stillHidden === true);

  // ---- 8) 暂停链路 ----
  await key('keyDown', 'p', 'KeyP', 80);
  await key('keyUp', 'p', 'KeyP', 80);
  await sleep(300);
  const paused = await evaluate(`document.getElementById('ov-title').textContent`);
  check('按 P 可暂停', paused === '已 暂 停', JSON.stringify(paused));

  // 恢复游戏：既验证了"暂停 → 继续"的完整往返，也让后面的截图能拍到战斗画面
  await key('keyDown', 'p', 'KeyP', 80);
  await key('keyUp', 'p', 'KeyP', 80);
  await sleep(300);
  const resumed = await evaluate(`document.getElementById('overlay').classList.contains('hidden')`);
  check('再按 P 可继续', resumed === true);

  // ---- 9) 主进程还活着吗（GPU 崩溃会导致主进程秒退但残留 CDP 端口，极易误判）----
  check('主进程仍存活（无 GPU 崩溃退出）', child.exitCode === null && child.signalCode === null);

  // ---- 10) 截图：必须放在所有输入断言之后（原因见上方 SHOT_MENU 分支注释）----
  if (process.env.SPACELINE_SHOT) {
    const r = await send('Page.captureScreenshot', { format: 'png' }, 20000);
    const f = process.env.SPACELINE_SHOT + '-playing.png';
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    console.log('   📷 ' + f);
  }

  console.log('\n控制台错误/未捕获异常：' + (problems.length ? '\n  ' + problems.join('\n  ') : '无 ✅'));
  if (problems.length) fail += problems.length;

  ws.close();
  cleanup();
  await sleep(500);
  console.log(fail === 0 ? '\n🎉 桌面端冒烟测试全部通过' : '\n⚠️ 有 ' + fail + ' 项未通过');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('❌ 冒烟测试出错: ' + e.message);
  if (stderrBuf) console.log('--- 进程 stderr ---\n' + stderrBuf.slice(0, 1500));
  cleanup();
  process.exit(1);
});
