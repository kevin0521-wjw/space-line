/**
 * 星际防线 · 桌面版主进程
 *
 * 职责非常克制：只负责"开一个刚好装得下游戏的窗口"，不碰任何游戏逻辑。
 * 游戏本身仍是那个纯静态的 index.html（由 tools/sync-renderer.js 从上层目录同步过来），
 * 主进程与渲染进程之间没有任何 IPC —— 不需要，也就没有攻击面。
 */

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

// ---------------------------------------------------------------------------
// 安全模式（默认关闭）
//
// 为什么需要：在无显卡 / 驱动异常 / 受限容器环境里，Chromium 的 GPU 进程会反复崩溃，
// 最后主进程直接以 `FATAL: GPU process isn't usable. Goodbye.` 退出 —— 窗口一闪都没有。
//
// 为什么不直接默认禁用硬件加速：正常机器上硬件加速才是对的选择（省电、掉帧更少）。
// 所以这里做成**显式开关**：默认走硬件加速，出问题再手动开安全模式，
// 而不是为了迁就个别环境牺牲所有人的默认体验。
//
// 开启方式：SpaceLine.exe --safe-mode   或   设置环境变量 SPACELINE_SAFE_MODE=1
// 必须在 app ready 之前执行，否则不生效。
// ---------------------------------------------------------------------------
const SAFE_MODE = process.argv.includes('--safe-mode')
  || /^(1|true|yes)$/i.test(process.env.SPACELINE_SAFE_MODE || '');

if (SAFE_MODE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  // in-process-gpu：把 GPU 工作放回主进程，绕开"GPU 子进程起不来"的环境
  app.commandLine.appendSwitch('in-process-gpu');
  // no-sandbox：某些宿主沙箱（Windows job object）与 Chromium 自带沙箱冲突
  app.commandLine.appendSwitch('no-sandbox');
  console.log('[safe-mode] 已禁用硬件加速与 GPU 子进程');
}

// ---------------------------------------------------------------------------
// 尺寸常量：为什么是 860×680？
// 页面 CSS 里画布宽度取 min(94vw, 800px, (100vh - var(--vpad)) * 4/3)。
// 窗口高度 ≤ 820px 时页面会走"矮视口分支"（藏起标题脚注，--vpad = 40px），
// 于是需要 94vw ≥ 800 → vw ≥ 851，以及 (vh - 40) * 4/3 ≥ 800 → vh ≥ 640。
// 取 860×680 就刚好开箱得到像素级 1:1 的 800×600 画布，且不会在 768p 屏上被系统压扁。
// （useContentSize: true 让这两个数字表示"内容区"而非"含边框的窗口"。）
// ---------------------------------------------------------------------------
const WIN_W = 860;
const WIN_H = 680;

let win = null;

/** 创建主窗口。参数：无。返回：无。 */
function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    useContentSize: true,
    minWidth: 680,
    minHeight: 600,
    title: '星际防线',
    backgroundColor: '#05070f',   // 与页面底色一致，消除启动瞬间的白屏闪烁
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,        // 再配合下面的 setApplicationMenu(null)，彻底去掉菜单栏
    show: false,                  // 等页面画好再显示，避免看到未渲染的空窗
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,     // 纯静态页面用不到 Node，关掉最安全
      sandbox: true,
      // 关键：Chromium 默认会在窗口失焦时把 requestAnimationFrame 降到 ~1FPS。
      // 游戏类窗口必须关掉这个节流，否则切出去再回来会出现明显的卡顿与跳帧。
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 页面首帧就绪后再显示（ready-to-show 早于它的话仍可能闪一下）
  win.once('ready-to-show', () => win.show());

  // 这个游戏不需要浏览器缩放：锁死 1:1，避免 Ctrl+滚轮把画面拉花
  win.webContents.setVisualZoomLevelLimits(1, 1);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // F11 全屏切换（游戏窗口的常规预期）
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
      return;
    }
    // 屏蔽 Ctrl+R / F5：游戏里 R 是"重开一局"，误按浏览器刷新会丢掉整局进度
    if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      event.preventDefault();
    }
  });

  // 纯本地应用不应该开出任何新窗口；万一页面里出现链接，交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------------------
// 单实例锁：双击两次图标不应该开出两个窗口，第二次只把已有窗口拉到前面
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    // 让 Windows 任务栏把窗口归到正确的应用 ID 下（否则图标可能显示成默认的 Electron 原子）
    app.setAppUserModelId('com.kevin0521.spaceline');
    Menu.setApplicationMenu(null);   // 没有任何菜单项需要暴露，直接清空
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
