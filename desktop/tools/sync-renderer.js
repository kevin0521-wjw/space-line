/**
 * 把上层的网页版 index.html 同步到 desktop/renderer/。
 *
 * 为什么要这一步：游戏的唯一真源是 space-shooter/index.html（网页版），
 * 桌面版只是给它套一个窗口壳。如果把 index.html 在 desktop 下再存一份"手改版"，
 * 两份代码立刻就会漂移 —— 网页版修了 bug，桌面版还带着旧问题。
 * 所以这里只做单向复制，让 renderer/index.html 永远是**派生产物**。
 *
 * 用法：node tools/sync-renderer.js（已挂在 npm start / npm run dist 前面自动执行）
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'index.html');
const DST_DIR = path.join(__dirname, '..', 'renderer');
const DST = path.join(DST_DIR, 'index.html');

// ---- 同步前先校验源文件，避免把一份半成品/坏文件复制进发布包 ----
if (!fs.existsSync(SRC)) {
  console.error('❌ 找不到源文件：' + SRC);
  process.exit(1);
}
const html = fs.readFileSync(SRC, 'utf8');
if (html.indexOf('<canvas') < 0 || html.indexOf('requestAnimationFrame') < 0) {
  console.error('❌ 源文件看起来不是游戏页面（缺少 canvas / requestAnimationFrame），已中止');
  process.exit(1);
}

fs.mkdirSync(DST_DIR, { recursive: true });
fs.writeFileSync(DST, html, 'utf8');

console.log('✅ 已同步渲染页 (' + html.length + ' 字符) → ' + path.relative(process.cwd(), DST));
