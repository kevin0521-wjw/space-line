# -*- coding: utf-8 -*-
"""
为「星际防线」生成 Windows 应用图标（.ico 多尺寸 + 预览 PNG）。

为什么要有这个脚本：electron-builder 打 exe 时若图标小于 256×256 会**直接报错**，
而缺 16/32/48 档的话任务栏和资源管理器里会糊成一团。所以图标必须是多档打包的 .ico。

实现要点：
  1. 先在 1024×1024（= 256 的 4 倍）上绘制，最后用 LANCZOS 逐档缩小 ——
     直接按 16px 画的话，飞船的细线和尾焰会糊成一片色块。
  2. 渐变用 Image.radial_gradient / Image.linear_gradient 生成灰度图，
     再用 ImageOps.colorize 映射到两端颜色 —— Pillow 的 ImageDraw 本身不支持渐变填充。
  3. 画面内容只占约 80%，四周留白：Windows 图标在任务栏里是靠边的，
     贴边绘制会被视觉上"顶到边框"。

运行（裸 python 没有 Pillow，必须用 managed venv）：
  "C:/Users/kevin/.workbuddy/binaries/python/envs/default/Scripts/python.exe" tools/make-icon.py
"""

import os
from PIL import Image, ImageDraw, ImageOps, ImageFilter

# ---------------- 可调参数：想换配色改这里 ----------------
SIZE = 1024                       # 超采样基准尺寸
CORNER_RATIO = 0.22               # 圆角半径占边长比例
BG_CENTER = "#12203f"             # 背景中心色（深空蓝）
BG_EDGE = "#04060f"               # 背景边缘色（近黑）
SHIP_TOP = "#eaf6ff"              # 机身顶部高光（白蓝）
SHIP_BOTTOM = "#3f8fd0"           # 机身底部（深蓝）
FLAME_INNER = "#d8f6ff"           # 尾焰芯（亮青白）
FLAME_OUTER = "#1f7fb8"           # 尾焰外沿（青蓝）
COCKPIT = "#0b2b4a"               # 座舱
STAR_COLOR = "#cfe8ff"            # 星点

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
PREVIEW = os.path.join(OUT_DIR, "icon.png")
ICO = os.path.join(OUT_DIR, "icon.ico")


def vgrad(size, top_color, bottom_color):
    """生成自上而下的线性渐变图。参数：size 边长、两端颜色。返回：RGB 图。"""
    # Image.linear_gradient 是 256×256 的黑(0)到白(255)竖直渐变
    gray = Image.linear_gradient("L").resize((size, size), Image.Resampling.BILINEAR)
    return ImageOps.colorize(gray, black=top_color, white=bottom_color)


def rgrad(size, center_color, edge_color):
    """生成中心向外的径向渐变图。参数：size 边长、中心色、边缘色。返回：RGB 图。"""
    gray = Image.radial_gradient("L").resize((size, size), Image.Resampling.BILINEAR)
    return ImageOps.colorize(gray, black=center_color, white=edge_color)


def build_icon():
    """绘制图标底图（1024×1024 RGB）。参数：无。返回：PIL.Image。"""
    s = SIZE
    img = rgrad(s, BG_CENTER, BG_EDGE)

    # ---- 星点：固定坐标而不是随机，保证每次生成的图标完全一致（可复现） ----
    stars = [(206, 300, 7), (812, 268, 9), (300, 826, 6), (742, 764, 8),
             (168, 560, 5), (866, 546, 6), (512, 158, 5), (620, 880, 5)]
    draw = ImageDraw.Draw(img)
    for (x, y, r) in stars:
        a = int(160 + r * 9)                     # 大一点的星更亮
        draw.ellipse([x - r, y - r, x + r, y + r], fill=STAR_COLOR + "")

    # ---- 尾焰：先画在单独图层上，再整体加高斯模糊做出发光感 ----
    flame = Image.new("L", (s, s), 0)
    fd = ImageDraw.Draw(flame)
    fd.polygon([(452, 706), (512, 918), (572, 706)], fill=255)
    flame = flame.filter(ImageFilter.GaussianBlur(14))
    flame_rgb = vgrad(s, FLAME_INNER, FLAME_OUTER)
    img.paste(flame_rgb, (0, 0), flame)

    # ---- 机身：渐变填充的菱形，用单通道遮罩把渐变"裁"成飞船形状 ----
    body_mask = Image.new("L", (s, s), 0)
    bd = ImageDraw.Draw(body_mask)
    bd.polygon([(512, 176), (604, 636), (512, 726), (420, 636)], fill=255)
    body = vgrad(s, SHIP_TOP, SHIP_BOTTOM)
    img.paste(body, (0, 0), body_mask)

    # ---- 机翼：与机身同色系但更暗，形成前后层次 ----
    wing_mask = Image.new("L", (s, s), 0)
    wd = ImageDraw.Draw(wing_mask)
    wd.polygon([(438, 470), (286, 700), (438, 686)], fill=255)
    wd.polygon([(586, 470), (738, 700), (586, 686)], fill=255)
    wings = vgrad(s, "#5aa9e6", "#245a8c")
    img.paste(wings, (0, 0), wing_mask)

    # ---- 座舱：椭圆形深色高光 ----
    cd = ImageDraw.Draw(img)
    cd.ellipse([512 - 54, 392 - 74, 512 + 54, 392 + 74], fill=COCKPIT)
    cd.ellipse([512 - 40, 392 - 58, 512 + 40, 392 + 46], fill="#134367")

    # ---- 圆角遮罩：Windows 桌面图标是自由形状，圆角看起来更像现代应用 ----
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=int(s * CORNER_RATIO), fill=255
    )
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    icon = build_icon()

    # 预览用 PNG（512），方便人眼快速检查
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(PREVIEW)

    # .ico：必须包含 256 档（electron-builder 的硬性要求），
    # 同时提供 16/24/32/48/64/128，覆盖任务栏、资源管理器、Alt+Tab 各种场景
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(
        ICO, format="ICO", sizes=sizes
    )

    print("已生成:")
    print("  ", os.path.normpath(PREVIEW))
    print("  ", os.path.normpath(ICO))

    # ---- 自检：确认 ico 里确实有 256 档且文件非空 ----
    data = open(ICO, "rb").read()
    assert data[:4] == b"\x00\x00\x01\x00", "ICO 头不正确"
    count = int.from_bytes(data[4:6], "little")
    widths = []
    for i in range(count):
        off = 6 + i * 16
        widths.append(data[off] or 256)   # 0 表示 256
    print("   ico 内含档位:", sorted(widths), " 文件大小:", len(data), "字节")
    assert 256 in widths, "缺少 256 档，electron-builder 会拒绝打包"
    assert all(w in widths for w in (16, 32, 48)), "缺少 16/32/48 档，任务栏图标会糊"


if __name__ == "__main__":
    main()
