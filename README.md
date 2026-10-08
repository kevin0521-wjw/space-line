# 星际防线 SpaceLine

**单文件 HTML5 太空射击游戏。** 零第三方库、零图片、零音频资源——飞船、敌人、粒子、BOSS、星空全部由 Canvas 2D 实时绘制。整个游戏就是 `index.html` 一个文件，双击即玩。

同一份源码同时产出三种形态：**网页版** / **桌面免安装版（portable exe）** / **桌面安装包（NSIS）**。

---

## 直接玩

| 形态 | 怎么开始 |
|---|---|
| **在线试玩** | **<https://kevin0521-wjw.github.io/space-line/>** —— 免安装、手机可直接打开。合并 PR 后自动更新 |
| 网页版 | 下载 `index.html`，双击（或拖进 Chrome / Edge 窗口）。无需服务器、无需联网 |
| 手机上 | 直接开上面的在线地址；或把 `index.html` 发到手机（微信文件 / 网盘都行）用浏览器打开。**横屏体验明显更好**（画布能大 30%） |
| 桌面版 | 见下方[打包桌面版](#打包桌面版)，或从 Releases 下载 |

> 在线地址是**只读的托管副本**——它用来「玩」，不用来「改」。想改代码见[参与修改](#参与修改)。

## 操作

```
键盘    ← → ↑ ↓ / W A S D    移动（斜向自动归一化，不会斜着走更快）
        空格                  射击（按住连发）
        Shift                 冲刺（短距突进，带无敌帧，1.1s 冷却）
        Q / 1 2 3             切换武器
        P / Esc               暂停          R  重开

鼠标    按住拖动 = 移动，拖动期间自动开火
触屏    手指拖动 = 移动 + 自动开火
        右下角圆钮 = 冲刺（钮上直接显示冷却秒数）
        左下角圆钮 = 换枪（钮上直接显示当前武器名）
```

## 玩法

- **连击倍率** —— 连续击杀不断则倍率从 x1 爬到 x5（每 5 连升 1 级），漏怪或受击立刻清零。这把「苟着不打」和「稳定清屏」区分开。
- **7 种道具** —— 护盾 / 散射 / 急速 / 清屏炸弹 / 增援 / 双列 / 激光。
- **3 把武器** —— 单发、双列（两条平行弹道）、激光（持续穿透光束）。**同位选择而非升级链条**：激光单体输出略高，但完全吃不到散射加成。
- **BOSS 三阶段** —— 每 5 级一场。血量降到 66% / 33% 时换阶段：横移更快、开火更密、弹幕从单发变扇形，三阶段追加 14 发环形弹幕。**每次切换都会清空场上敌弹**，给玩家一个喘息节拍。
- **本地排行榜** —— 分数 / 到达等级 / 存活时长，Top 5，存在 `localStorage`。

---

## 目录结构

```
index.html                    ← 唯一的源文件，全部玩法都在这里
dist/使用说明.txt              ← 面向玩家的说明（含三种形态的打包内容清单，随发行包分发）

verify/
  selftest.js                 ← 逻辑自检：在 Node 里搭最小浏览器环境直接跑游戏脚本
  browsertest.js              ← 真机验证：headless Edge + CDP，含手机视口触摸测试
  livetest.js                 ← 公网验证：打开 GitHub Pages 上那份真玩一遍
  shot-action.js              ← 分镜截图：用状态钩子摆出指定局面再截图

desktop/                      ← Electron 窗口壳
  main.js
  package.json                ← electron-builder 配置（portable + nsis）
  build/                      ← 应用图标
  tools/sync-renderer.js      ← 把根目录 index.html 同步进 renderer/
  tools/smoke-test.mjs        ← 启动打包好的 exe，用 CDP 验证并截图
```

**源只有一份。** `web/index.html` 与 `desktop/renderer/index.html` 都是根目录 `index.html` 的**生成副本**，被 `.gitignore` 排除——跑一次同步脚本即可重建。

## 自己改参数

所有可调数值集中在 `index.html` 顶部的 `CFG` 对象里，每条都带中文注释说明**为什么是这个值**而不是另一个。例如：

```js
MAX_DT: 1 / 30,        // 单帧最大步长。不夹住的话，切标签页回来那一帧
                       // 会积攒几秒的 dt，子弹直接穿过敌人（隧穿）
TOUCH: {
  FOLLOW: 17,          // 1-exp(-k·dt) 的 k。指数形式与帧率无关，
                       // 144Hz 和 60Hz 下跟随手感完全一致
  DRAG_GAIN: 1.42,     // 手指移 1px 飞船移 1.42px —— 手机屏窄，1:1 够不到两边
},
WEAPON: {
  PULSE: { cd: 0.13, dmg: 1 },       // 单发
  TWIN:  { cd: 0.17, dmg: 1, offset: 11 },
  LASER: { cd: 0,    dps: 16, width: 10 },
},
```

## 参与修改

**注意：在线试玩地址（GitHub Pages）是只读托管，改不了代码。** 要改代码，走仓库这一层：

### 方式一：Fork + Pull Request（无需授权，推荐）

```bash
# 1. 点仓库右上角 Fork，得到你自己的副本
# 2. 克隆你自己的副本
git clone https://github.com/<你的用户名>/space-line.git
cd space-line

# 3. 改 index.html，改完双击就能试玩（源文件就是可直接运行的游戏本体）
# 4. 提交并推送
git add -A && git commit -m "调整 BOSS 弹幕速度"
git push
```

然后在 GitHub 上点 **Compare & pull request**。改动会逐行展示、可评论、可要求修改，**合并与否由仓库维护者决定**。谁都能提案，拍板权在维护者手里。

### 方式二：直接给写权限（需要维护者操作）

仓库 Settings → Collaborators → Add people，加对方 GitHub 用户名，角色选 **Write**，对方就能直接 `git push` 到这个仓库。各档权限：

| 角色 | 能做什么 |
|---|---|
| Read | 只能克隆、看代码 |
| **Write** | 能推代码、开 Issue / PR ← 默认给这档 |
| Maintain | 额外能改仓库设置（不能删仓库） |
| Admin | 能删仓库、能踢人 ← 别给 |

**第三方实时协作**（双方同时改同一个文件，改完立即看到）：[VS Code Live Share](https://visualstudio.microsoft.com/services/live-share/)（需双方装 VS Code 登录微软账号）、[CodePen Collab Mode](https://codepen.io/)（把 `index.html` 内容贴进 HTML 面板，免安装）。

### 改完记得跑测试

三套断言都绿了再提 PR（用法见下方[测试](#测试)）。它们覆盖了触屏拖动、武器切换、BOSS 三阶段切换、排行榜存档清洗这些容易被改坏的地方。

## 测试

```bash
node verify/selftest.js      # 122 项逻辑断言
node verify/browsertest.js   # 32 项真机断言 + 截图（需要本机装有 Edge）
node verify/livetest.js      # 14 项公网地址断言（需要已开 GitHub Pages）
```

`selftest.js` 通过把 `Math.random` 换成常量让局面完全可复现，再用两套手段观测：

1. **反解绘制调用** —— 从 stub 的 `ctx.fillText` / `ctx.arc` 里读出 HUD 实际画了什么，验证「玩家真的看到了什么」，跨版本最稳；
2. **状态钩子** —— `index.html` 暴露的 `window.__SpaceLine`，直接断言连击倍率、护盾、Boss 血量这类内部状态，比反解像素强得多。

`browsertest.js` 用 headless Edge + CDP（WebSocket 直连，不依赖 puppeteer）跑真机回归，包含 390×844 手机视口下用**真实触摸事件**驱动拖动。

`livetest.js` 打开线上 `https://kevin0521-wjw.github.io/space-line/` 真玩一遍。**它不是重复劳动**——`curl` 比哈希只能证明「服务器吐给我的字节是对的」，证明不了「浏览器拿到这些字节后能跑起来」，中间还夹着响应头、缓存/Service Worker、以及 HTTPS 下 `localStorage` 是否可用这几层。库里还做了一个独立交叉验证：让**浏览器自己** fetch 一次并用 `crypto.subtle` 算 SHA-256，与 Node 侧算的本地哈希比对，连「curl 和浏览器网络路径不同、看到的可能不是同一份」这个疑点也一并排掉。

## 打包桌面版

```bash
cd desktop
npm install
npm run sync      # 把根目录 index.html 同步进 renderer/
npm run dist      # 产出 portable.exe + setup.exe
```

---

## 几个实现上的取舍

**触屏用「相对拖动」而不是「飞船跟手」。** 按下时同时记下手指位置和飞船位置两条基准，之后飞船位移 = 手指位移。跟手的话手指必然挡住飞船，而手指接触面积约 40~50px、飞船碰撞半径只有 16px——等于让你用一支很粗的笔描一条很细的线。另外补了三件事：指针捕获（滑出画布松手不会卡住）、多指保护（右手点按钮不顶掉左手的拖动基准）、`1-exp(-k·dt)` 帧率无关插值。

**持续型伤害一律 `DPS × dt`，绝不按帧结算。** 激光写成每帧扣固定值的话，120Hz 手机上会比 60Hz 强一倍。

**BOSS 换阶段时清空全场敌弹。** 切阶段那一刻屏幕上往往已经积了一屏弹幕，再叠新弹会让人死得像是运气而不是操作。规则的公平性比难度更重要。

**排行榜存档会清洗。** `localStorage` 是玩家随手就能改的，读回来的数组必须先做结构校验再渲染，否则一条脏数据能让开始界面白屏。

## 许可

MIT，见 [LICENSE](LICENSE)。
