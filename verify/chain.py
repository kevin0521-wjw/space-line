#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""五层哈希链 —— 同步与校验。

星际防线的唯一真源是 index.html（单文件游戏，全部玩法都在这一个文件里）。
这一份代码会被复制成 5 份，散落在不同交付物中。任何一份漂移了，都会导致
"网页版和桌面版不是同一个游戏"这种最难查的问题。

  L1  源文件       index.html                                        <- 唯一要改的东西
  L2  网页版       web/index.html                                    <- GitHub Pages 用
  L3  桌面渲染页   desktop/renderer/index.html                       <- Electron 用
  L4  发布 zip     dist/<发布包>.zip 内的 index.html
  L5  桌面 exe     desktop/release_vX/win-unpacked/resources/app.asar 内的 /renderer/index.html

L1 -> L2/L3 能瞬间自动同步；L4/L5 必须重新打包才会变。
所以这里把"改代码"和"发版本"分成两件事：

  改代码期间   python verify/chain.py sync     或 watch 常驻，保存即同步
  发版本时     python verify/chain.py release  重打包 L4/L5，并校验五层全等

用法：
  python verify/chain.py check       校验五层，列出差异
  python verify/chain.py sync        L1 -> L2/L3 同步，然后校验
  python verify/chain.py watch       常驻监听，index.html 一变就同步（Ctrl+C 停）
  python verify/chain.py pack-zip    只重打发布 zip（要求桌面 exe 已是最新）
  python verify/chain.py release     完整重打包：sync + electron-builder + 重打 zip + 校验

可选参数：
  --force       同步时跳过源文件健壮性检查（你确定文件是完整的）
  --out PATH    pack-zip 的输出路径（默认写回 dist 下的同名 zip）
  --interval N  watch 的轮询间隔秒数（默认 1.0）
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zipfile
from datetime import datetime

try:
    # line_buffering 是必需的：watch 常驻进程把输出重定向到日志文件时，
    # 默认的块缓冲会让日志在进程被杀之前一个字都写不出来（踩过）。
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass

# SPACELINE_ROOT 用于把整条链指到另一个目录（做端到端自测时不用碰真实项目）
ROOT = os.environ.get("SPACELINE_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SRC = os.path.join(ROOT, "index.html")
WEB = os.path.join(ROOT, "web", "index.html")
RENDERER = os.path.join(ROOT, "desktop", "renderer", "index.html")
DIST = os.path.join(ROOT, "dist")
DESKTOP = os.path.join(ROOT, "desktop")

PROJECT = "星际防线 SpaceLine"

# 追加进发布 zip 的实拍图：(verify/ 下的文件名, 包内路径)
# 为什么要单独列一份：包里的截图是**只存在于 zip 里**的一次性素材，
# 打包走"以上一版为模板"的路子，所以本版新拍的图不会自动进去 ——
# 不显式列出来，包里的截图就会永远停留在上一版。
EXTRA_SHOTS = [
    ("_shot_12_ai_action.png", "截图/网页版-AI自动接管.png"),
    ("_shot_13_desktop_app.png", "截图/桌面版-AI自动接管.png"),
]

# 颜色只在真终端里开，管道/重定向时关掉，免得出乱码
if sys.stdout.isatty():
    GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
else:
    GREEN = RED = YELLOW = DIM = RESET = ""

# 源文件健壮性下限：真文件约 184 KB。低于这个值八成是编辑器写到一半。
MIN_SRC_BYTES = 100_000


# ---------------------------------------------------------------- 基础工具


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def dwidth(s):
    """终端显示宽度：中日韩全角字符按 2 列算，否则对齐会歪。"""
    return sum(2 if ord(c) > 0x1100 else 1 for c in s)


def cell(text, width, color=""):
    tail = " " * max(0, width - dwidth(text))
    return (color + text + RESET if color else text) + tail


def rel(path):
    try:
        return os.path.relpath(path, ROOT)
    except Exception:
        return path


def read_version():
    p = os.path.join(DESKTOP, "package.json")
    try:
        with open(p, encoding="utf-8") as f:
            return str(json.load(f).get("version") or "0.0.0")
    except Exception:
        return "0.0.0"


# ---------------------------------------------------------------- 各层探测


def asar_extract(asar_path, predicate):
    """从 app.asar 里按谓词抽取文件，返回 [(内部路径, bytes)]。

    asar = 16 字节头 + JSON 索引 + 数据区。
    索引里的 offset 是相对数据区起点算的，而数据区起点必须 4 字节对齐 ——
    这个对齐是之前踩过的坑：不对齐会得到"长度一模一样但哈希不同"的假失败。
    """
    out = []
    with open(asar_path, "rb") as f:
        (_, _, _, json_len) = struct.unpack("<4I", f.read(16))
        header = json.loads(f.read(json_len).decode("utf-8"))
        data_start = 16 + json_len
        if data_start % 4:
            data_start += 4 - data_start % 4

        def walk(node, prefix=""):
            for name, ent in node.get("files", {}).items():
                full = prefix + "/" + name
                if "files" in ent:
                    walk(ent, full)
                elif predicate(full):
                    f.seek(data_start + int(ent["offset"]))
                    out.append((full, f.read(int(ent["size"]))))

        walk(header)
    return out


def find_asar(version):
    """优先按版本号找 desktop/release_vXYZ/，找不到就退回最新的 release*/。"""
    tag = "v" + version.replace(".", "")
    guess = os.path.join(DESKTOP, "release_" + tag, "win-unpacked", "resources", "app.asar")
    if os.path.exists(guess):
        return guess
    best, best_m = None, -1
    if os.path.isdir(DESKTOP):
        for name in sorted(os.listdir(DESKTOP)):
            if not name.startswith("release"):
                continue
            p = os.path.join(DESKTOP, name, "win-unpacked", "resources", "app.asar")
            if os.path.exists(p) and os.path.getmtime(p) > best_m:
                best, best_m = p, os.path.getmtime(p)
    return best


def find_release_zip(version):
    """dists 下优先挑文件名带当前版本号的 zip，否则退回第一个。"""
    if not os.path.isdir(DIST):
        return None
    zips = sorted(f for f in os.listdir(DIST) if f.lower().endswith(".zip"))
    if not zips:
        return None
    tag = "v" + version
    for f in zips:
        if tag in f:
            return os.path.join(DIST, f)
    return os.path.join(DIST, zips[0])


def collect(version):
    """探测五层现状，返回列表。hash 为 None 表示这一层取不到内容。"""
    layers = []

    def add(idx, name, kind, path, digest, size, note=""):
        layers.append(dict(idx=idx, name=name, kind=kind, path=path,
                           hash=digest, size=size, note=note))

    if os.path.exists(SRC):
        add(1, "源文件", "src", SRC, sha256_file(SRC), os.path.getsize(SRC), rel(SRC))
    else:
        add(1, "源文件", "src", SRC, None, 0, "找不到 " + rel(SRC))

    for idx, name, path in ((2, "网页版", WEB), (3, "桌面渲染页", RENDERER)):
        if os.path.exists(path):
            add(idx, name, "file", path, sha256_file(path), os.path.getsize(path), rel(path))
        else:
            add(idx, name, "file", path, None, 0, "缺失 " + rel(path))

    zp = find_release_zip(version)
    if zp and os.path.exists(zp):
        with zipfile.ZipFile(zp) as z:
            hits = [n for n in z.namelist() if n.lower().endswith("index.html")]
            if hits:
                data = z.read(hits[0])
                add(4, "发布 zip", "zip", zp, sha256_bytes(data), len(data),
                    "%s :: %s" % (os.path.basename(zp), hits[0]))
            else:
                add(4, "发布 zip", "zip", zp, None, 0, "包内没有 index.html")
    else:
        add(4, "发布 zip", "zip", "", None, 0, "dist/ 下没有 zip")

    ap = find_asar(version)
    if ap:
        hits = asar_extract(ap, lambda p: p.lower().endswith("index.html"))
        if hits:
            full, data = hits[0]
            add(5, "桌面 exe", "asar", ap, sha256_bytes(data), len(data),
                "%s :: %s" % (rel(ap), full))
        else:
            add(5, "桌面 exe", "asar", ap, None, 0, "asar 内没有 index.html")
    else:
        add(5, "桌面 exe", "asar", "", None, 0, "找不到 app.asar")

    return layers


# ---------------------------------------------------------------- 输出


def print_table(layers):
    base = layers[0]["hash"]
    print()
    print("  " + cell("层", 5) + cell("名称", 14, DIM) + cell("状态", 10, DIM)
          + cell("大小", 11, DIM) + cell("sha256", 18, DIM))
    print("  " + "-" * 72)
    for L in layers:
        h = L["hash"]
        if L["idx"] == 1:
            stat, color = "基准", DIM
        elif h is None:
            stat, color = "缺失", RED
        elif h == base:
            stat, color = "一致", GREEN
        else:
            stat, color = "不一致", RED
        size = "{:,}".format(L["size"]) if L["size"] else "-"
        digest = (h[:16] + "...") if h else "-"
        print("  " + cell("L%d" % L["idx"], 5) + cell(L["name"], 14)
              + cell(stat, 10, color) + cell(size, 11) + cell(digest, 18, color))
        if L["note"]:
            print("       " + DIM + "- " + L["note"] + RESET)


def summarize(layers):
    base = layers[0]["hash"]
    core_ok = layers[1]["hash"] == base and layers[2]["hash"] == base
    pub_ok = layers[3]["hash"] == base and layers[4]["hash"] == base
    print()
    if core_ok:
        print("  \u2705 代码层 L1-L3 已统一   " + DIM + base + RESET)
    else:
        print("  \u274c 代码层 L1-L3 不一致")
        print("     " + DIM + "修复：python verify/chain.py sync" + RESET)
    if pub_ok:
        print("  \u2705 发布层 L4-L5 已统一")
    else:
        print("  \u26a0\ufe0f  发布层 L4-L5 落后于源文件")
        print("     " + DIM + "这是正常的 —— 发布包只在发版本时重建。"
              "要重建：python verify/chain.py release" + RESET)
    print()
    return core_ok


# ---------------------------------------------------------------- 同步


def validate_source(force=False):
    """同步前确认源文件是个完整的游戏页，别把半成品复制到交付物里。"""
    if not os.path.exists(SRC):
        return False, "找不到 %s" % rel(SRC)
    size = os.path.getsize(SRC)
    with open(SRC, "rb") as f:
        blob = f.read()

    if force:
        return True, ""

    if size < MIN_SRC_BYTES:
        return False, "只有 %s 字节，看起来还没写完（源文件应约 184 KB）" % "{:,}".format(size)
    if b"<canvas" not in blob:
        return False, "里面没有 <canvas>，不像游戏页"
    if b"requestAnimationFrame" not in blob:
        return False, "里面没有 requestAnimationFrame，不像游戏页"
    if b"window.__SpaceLine" not in blob:
        return False, "缺少 window.__SpaceLine 测试钩子"
    if b"</html>" not in blob[-8192:]:
        return False, "结尾没有 </html>，文件可能是被截断的"
    return True, ""


def do_sync(force=False, quiet=False):
    """把 L1 逐字节复制到 L2 / L3。返回 True 表示三层现已一致。"""
    ok, why = validate_source(force)
    if not ok:
        print("  \u274c 源文件未通过检查：" + why)
        print("     " + DIM + "（确认文件已保存完整；确实要强制同步就加 --force）" + RESET)
        return False

    src_hash = sha256_file(SRC)
    src_size = os.path.getsize(SRC)
    changed = []

    for path in (WEB, RENDERER):
        before = sha256_file(path) if os.path.exists(path) else None
        if before == src_hash:
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # 二进制复制：不经文本解码，杜绝换行/编码转换导致的哈希漂移
        shutil.copyfile(SRC, path)
        after = sha256_file(path)
        if after != src_hash:
            print("  \u274c 写入后哈希不符：%s" % rel(path))
            return False
        changed.append((rel(path), before))

    if not quiet:
        if changed:
            for name, before in changed:
                arrow = (before[:10] + "...") if before else "(新建)"
                print("  \u2705 已同步 %-30s %s -> %s" % (name, arrow, src_hash[:10] + "..."))
        else:
            print("  \u2705 L2 / L3 本来就是最新的，无需改动")

    # 写完再验一遍，确保真的是三层同一份
    for path in (WEB, RENDERER):
        if not os.path.exists(path) or sha256_file(path) != src_hash:
            print("  \u274c 校验失败：%s 与源文件不一致" % rel(path))
            return False
    if not quiet:
        print("  " + DIM + "源文件 %s 字节  %s" % ("{:,}".format(src_size), src_hash) + RESET)
    return True


def do_watch(interval=1.0, force=False):
    print()
    print("  监听中：%s" % rel(SRC))
    print("  " + DIM + "保存即刻同步到 L2 / L3，Ctrl+C 停止" + RESET)
    print()

    def stat_now():
        try:
            s = os.stat(SRC)
            return (s.st_mtime_ns, s.st_size)
        except OSError:
            return None

    last = stat_now()
    print("  " + DIM + "%s  已就绪，当前 %s" % (
        datetime.now().strftime("%H:%M:%S"),
        (last[1] and "{:,} 字节".format(last[1])) or "读取失败") + RESET)

    try:
        while True:
            time.sleep(interval)
            cur = stat_now()
            if cur is None or cur == last:
                continue
            # 编辑器保存常常分几次写入，等一下再读，避开中间态
            time.sleep(0.3)
            cur = stat_now()
            last = cur
            stamp = datetime.now().strftime("%H:%M:%S")
            print("  [%s] 检测到变化 (%s 字节)，开始同步" % (
                stamp, "{:,}".format(cur[1]) if cur else "?"))
            if do_sync(force=force, quiet=False):
                print("  [%s] 同步完成" % datetime.now().strftime("%H:%M:%S"))
            print()
    except KeyboardInterrupt:
        print("\n  已停止监听。")


# ---------------------------------------------------------------- 发布打包


def release_dir(version):
    return os.path.join(DESKTOP, "release_v" + version.replace(".", ""))


def do_pack_zip(version, out_path=None, force=False, extra=None):
    """重打发布 zip：以现有 zip 为模板，替换 index.html / 使用说明 / 桌面 exe，
    并把包内所有带版本号的条目名改成当前版本。

    走"模板替换"而不是"从零组装"，是为了不丢包里的截图这些一次性素材
    —— 它们在项目里没有留存副本，只在包里。

    下面三件事缺一不可，缺任何一件都会发出一个"看起来正常、其实内容错"的包：
      1) **改条目名**。模板包里是 SpaceLine-1.2.0-*.exe 和 星际防线-...-v1.2.0/，
         新版文件名里带的是新版本号 —— 只换内容不改名字的话，解压出来会是
         "1.3.0 的压缩包里装着 1.2.0 的 exe"。
      2) **换掉包内的 使用说明.txt**。它随版本改（本版新增了 AI 与二倍速说明），
         不换就会与 exe、index.html 自相矛盾。
      3) **不要覆盖模板包**。原来的默认输出就是模板本身，等于"发新版 = 抹掉旧版"，
         历史版本就此丢失。
    """
    ok, why = validate_source(force)
    if not ok:
        print("  \u274c 源文件未通过检查：" + why)
        return False

    template = find_release_zip(version)
    if not template or not os.path.exists(template):
        print("  \u274c dist/ 下找不到可作模板的 zip")
        return False

    rdir = release_dir(version)
    if extra is None:
        here = os.path.dirname(os.path.abspath(__file__))
        extra = [(os.path.join(here, a), b) for a, b in EXTRA_SHOTS]
    # 按"基础名 + 任意版本号"配对，而不是按全名 —— 模板里是旧版本号
    pairs = [
        (re.compile(r"^SpaceLine-[\d.]+-portable\.exe$"),
         os.path.join(rdir, "SpaceLine-%s-portable.exe" % version)),
        (re.compile(r"^SpaceLine-[\d.]+-setup\.exe$"),
         os.path.join(rdir, "SpaceLine-%s-setup.exe" % version)),
    ]
    readme_path = os.path.join(DIST, "使用说明.txt")
    have_readme = os.path.exists(readme_path)

    with zipfile.ZipFile(template) as z:
        names = z.namelist()
    if not any(os.path.basename(n).lower() == "index.html" for n in names):
        print("  \u274c 模板 zip 里没有 index.html")
        return False

    old_top = names[0].split("/")[0] if names else ""
    new_top = "星际防线-SpaceLine-v%s" % version

    src_html = open(SRC, "rb").read()
    out = out_path or os.path.join(DIST, "%s.zip" % new_top)
    if os.path.abspath(out) == os.path.abspath(template):
        print("  \u274c 拒绝把模板包本身当输出（那会把历史版本抹掉）")
        return False
    tmp = out + ".tmp"

    print("  模板：%s" % rel(template))
    print("  顶层目录：%s  ->  %s" % (old_top, new_top))
    print("  换入 index.html（%s 字节）" % "{:,}".format(len(src_html)))
    n_exe = 0
    for pat, local in pairs:
        if os.path.exists(local):
            n_exe += 1
            print("  换入 %s  <-  %s" % (os.path.basename(local), rel(local)))
        else:
            print("  " + YELLOW + "  注意：缺少 %s，包里的 exe 会保持旧版" % rel(local) + RESET)
    if have_readme:
        print("  换入 使用说明.txt")

    t0 = time.time()
    added = 0
    with zipfile.ZipFile(template) as zin, zipfile.ZipFile(tmp, "w") as zout:
        for item in zin.infolist():
            name = item.filename          # 原始条目名：读 zip 内容必须用它
            base = os.path.basename(name)
            arc = name
            data = None
            if old_top and arc.startswith(old_top + "/"):
                arc = new_top + arc[len(old_top):]
            if base.lower() == "index.html":
                data = src_html
            elif base == "使用说明.txt" and have_readme:
                data = open(readme_path, "rb").read()
            else:
                for pat, local in pairs:
                    if pat.match(base) and os.path.exists(local):
                        data = open(local, "rb").read()
                        folder = os.path.dirname(arc).replace("\\", "/")
                        arc = (folder + "/" if folder else "") + os.path.basename(local)
                        break
            item.filename = arc
            if data is None:
                # 其余条目原样搬运，保留原有压缩方式
                zout.writestr(item, zin.read(name))
            else:
                zout.writestr(item, data)
        # 追加本版新增的实拍图（存在才加；缺图不该让整个打包失败）
        for local, arcname in (extra or []):
            if os.path.exists(local):
                zout.write(local, new_top + "/" + arcname)
                added += 1
                print("  追加：%s" % arcname)
    os.replace(tmp, out)

    print("  \u2705 已写出 %s（%s 字节，%d 个新条目，耗时 %.1fs）" % (
        rel(out), "{:,}".format(os.path.getsize(out)), added, time.time() - t0))
    if n_exe == 0:
        print("  " + YELLOW + "  注意：包里的桌面 exe 是旧版" + RESET)
        print("  " + DIM + "        先构建 desktop/release_v%s 再打包" % version.replace(".", "") + RESET)
    return True
def do_release(version, force=False):
    """完整重打包：sync -> electron-builder -> 整理产物 -> 重打 zip -> 校验。"""
    print("\n=== 1/5  同步代码层 ===")
    if not do_sync(force=force):
        return False

    print("\n=== 2/5  用 electron-builder 重建桌面 exe ===")
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        print("  \u274c 找不到 npm，无法打包桌面版")
        return False
    print("  " + DIM + "这一步会跑几分钟（portable + nsis 两个目标都要压 145 MB）" + RESET)
    r = subprocess.run([npm, "run", "dist"], cwd=DESKTOP, shell=(os.name == "nt"))
    if r.returncode != 0:
        print("  \u274c electron-builder 失败，退出码 %d" % r.returncode)
        return False

    print("\n=== 3/5  整理产物到 release_v%s ===" % version.replace(".", ""))
    built = os.path.join(DESKTOP, "release")
    rdir = release_dir(version)
    if not os.path.isdir(built):
        print("  \u274c 找不到 %s" % rel(built))
        return False
    if os.path.isdir(rdir):
        shutil.rmtree(rdir)
    shutil.copytree(built, rdir)
    print("  \u2705 %s -> %s" % (rel(built), rel(rdir)))

    print("\n=== 4/5  重打发布 zip ===")
    if not do_pack_zip(version, force=force):
        return False

    print("\n=== 5/5  校验五层 ===")
    layers = collect(version)
    print_table(layers)
    ok = summarize(layers)
    if ok and all(L["hash"] == layers[0]["hash"] for L in layers):
        print("  \U0001f389 五层全等，可以发布了\n")
    return ok


# ---------------------------------------------------------------- 入口


def main():
    ap = argparse.ArgumentParser(
        prog="chain.py",
        description="星际防线五层哈希链 —— 同步与校验",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("command", choices=["check", "sync", "watch", "pack-zip", "release"])
    ap.add_argument("--force", action="store_true", help="跳过源文件健壮性检查")
    ap.add_argument("--out", default=None, help="pack-zip 的输出路径")
    ap.add_argument("--interval", type=float, default=1.0, help="watch 轮询间隔（秒）")
    args = ap.parse_args()

    version = read_version()

    if args.command == "check":
        layers = collect(version)
        print()
        print("  %s · v%s · 五层哈希链" % (PROJECT, version))
        print_table(layers)
        summarize(layers)
        return 0

    if args.command == "sync":
        print("\n  %s · 同步代码层（L1 -> L2 / L3）" % PROJECT)
        ok = do_sync(force=args.force)
        layers = collect(version)
        print_table(layers)
        summarize(layers)
        return 0 if ok else 1

    if args.command == "watch":
        do_watch(interval=args.interval, force=args.force)
        return 0

    if args.command == "pack-zip":
        print("\n  %s · 重打发布 zip" % PROJECT)
        ok = do_pack_zip(version, out_path=args.out, force=args.force)
        if ok:
            layers = collect(version)
            print_table(layers)
            summarize(layers)
        return 0 if ok else 1

    if args.command == "release":
        print("\n  %s · v%s 完整重打包" % (PROJECT, version))
        ok = do_release(version, force=args.force)
        return 0 if ok else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
