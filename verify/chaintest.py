"""
chain.py 的单元测试：只测纯逻辑，不碰真实构建产物。

为什么单独写：do_release 里那两步一旦出错，代价是**把"失败"伪装成"成功"**
或者把唯一的校验源删掉 —— 这类错误在真跑一次 4 分钟的构建里既慢又难归因。

覆盖的两处：
  merge_tree  —— 逐文件覆盖而不是 rmtree+copytree（保住 L5 这个唯一的校验源）
  has_payload —— 判断"这次真的产出了能发货的东西"

用法：python verify/chaintest.py
"""
import importlib.util
import os
import shutil
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(ROOT)

spec = importlib.util.spec_from_file_location("chain", os.path.join(HERE, "chain.py"))
chain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chain)

fails = []


def ck(name, cond, extra=""):
    print(("  ✅ " if cond else "  ❌ ") + name + (("  " + extra) if extra else ""))
    if not cond:
        fails.append(name)


def merge_cases():
    print("\n[merge_tree] 逐文件覆盖，不删目标")
    d = tempfile.mkdtemp(prefix="mt_")
    src, dst = os.path.join(d, "src"), os.path.join(d, "dst")
    os.makedirs(os.path.join(src, "win-unpacked", "resources"))
    os.makedirs(dst)
    open(os.path.join(src, "a.txt"), "w").write("NEW")
    open(os.path.join(src, "win-unpacked", "resources", "app.asar"), "w").write("NEWPAYLOAD")
    open(os.path.join(dst, "a.txt"), "w").write("OLDOLDOLD")
    open(os.path.join(dst, "stale.txt"), "w").write("上一版残留")

    n, skipped = chain.merge_tree(src, dst)
    ck("覆盖了 2 个文件", n == 2, "n=%d" % n)
    ck("被覆盖的文件内容真的换了", open(os.path.join(dst, "a.txt")).read() == "NEW")
    ck("新建的子目录与文件都在", os.path.exists(os.path.join(dst, "win-unpacked", "resources", "app.asar")))
    # 这一条是整个改动的理由：rmtree+copytree 会把"上一版多出来的文件"连同目录一起清掉，
    # 中途失败就什么都不剩。覆盖式合并任何时刻都留着上一版可用。
    ck("目标里上一版多出来的文件没被删", os.path.exists(os.path.join(dst, "stale.txt")))
    ck("没有被跳过的文件", skipped == [], str(skipped))

    dst2 = os.path.join(d, "dst2")
    n2, _ = chain.merge_tree(src, dst2)
    ck("目标不存在时会自动创建", n2 == 2 and os.path.isdir(dst2), "n=%d" % n2)

    dst3 = os.path.join(d, "dst3")
    open(dst3, "w").write("x")          # 目标是个已存在的**文件**而不是目录
    n3, sk3 = chain.merge_tree(src, dst3)
    ck("目标是文件时不会崩，且如实报告跳过", n3 == 0 and len(sk3) > 0, "n=%d skipped=%d" % (n3, len(sk3)))
    shutil.rmtree(d, ignore_errors=True)


def payload_cases():
    print("\n[has_payload] 判据必须落在真正发货的 exe 上")
    d = tempfile.mkdtemp(prefix="hp_")

    # 这是本文件最关键的一条：第一版判据是"目录里有 app.asar 就算"，
    # 而构建失败后目录里往往还留着**上一版**的 app.asar ——
    # 照那个判据会把陈旧产物当成本次产物，让流程"通过"。
    only_asar = os.path.join(d, "onlyasar")
    os.makedirs(os.path.join(only_asar, "win-unpacked", "resources"))
    open(os.path.join(only_asar, "win-unpacked", "resources", "app.asar"), "w").write("x")
    ck("只有上一版残留 app.asar → 必须 False", chain.has_payload(only_asar) is False)

    only_axe = os.path.join(d, "onlyexe")
    os.makedirs(only_axe)
    open(os.path.join(only_axe, "SpaceLine-1.3.0-portable.exe"), "w").write("x")
    ck("有 portable exe → True", chain.has_payload(only_axe) is True)

    setup_axe = os.path.join(d, "setupexe")
    os.makedirs(setup_axe)
    open(os.path.join(setup_axe, "SpaceLine-1.3.0-setup.exe"), "w").write("x")
    ck("有 setup exe → True", chain.has_payload(setup_axe) is True)

    other = os.path.join(d, "other")
    os.makedirs(other)
    open(os.path.join(other, "SomeUnrelatedTool.exe"), "w").write("x")
    ck("无关的 exe 不算数 → False", chain.has_payload(other) is False)

    ck("不存在的目录 → False", chain.has_payload(os.path.join(d, "nope")) is False)

    real = os.path.join(ROOT, "desktop", "release_v130")
    if os.path.isdir(real):
        ck("真实构建目录（有 portable/setup）→ True", chain.has_payload(real) is True)
    stale = os.path.join(ROOT, "desktop", "release")
    if os.path.isdir(stale):
        ck("真实残留目录（只有旧 asar）→ False", chain.has_payload(stale) is False)

    shutil.rmtree(d, ignore_errors=True)


merge_cases()
payload_cases()
print()
if fails:
    print("❌ %d 项未通过：%s" % (len(fails), fails))
    raise SystemExit(1)
print("🎉 chain.py 单元测试全部通过")
