# -*- coding: utf-8 -*-
"""回读 GitHub Release v1.3.0 的附件清单，和本地逐个对齐。
只用 api.github.com（直连通）；github.com 那个域名本机常年被阻断。
"""
import hashlib, json, os, sys, time, urllib.request

OWNER = "kevin0521-wjw"
REPO = "space-line"
TAG = "v1.3.0"
LOCAL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 本地三个应当上传的文件（相对 space-shooter/）
LOCAL = {
    "SpaceLine-1.3.0-portable.exe": "desktop/release_v130/SpaceLine-1.3.0-portable.exe",
    "SpaceLine-1.3.0-setup.exe": "desktop/release_v130/SpaceLine-1.3.0-setup.exe",
    "SpaceLine-v1.3.0-full.zip": "dist/星际防线-SpaceLine-v1.3.0.zip",
}


def api(path, token, tries=5):
    """GET 一个 API 端点，带重试。

    上一轮就是这里栽的：curl 单次返回空响应 → json.load 抛 JSONDecodeError。
    空响应在代理抖动时很常见，不该当成「请求失败」，重试即可。
    """
    url = f"https://api.github.com{path}"
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "spaceline-readback",
            })
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # 网络抖动、空响应、5xx 都在这里
            last = e
            print(f"  .. 第 {i+1} 次失败（{type(e).__name__}: {e}），重试", file=sys.stderr)
            time.sleep(2 * (i + 1))
    raise last


def main():
    token = os.environ.get("GH_TOKEN", "").strip()
    if not token:
        print("需要 GH_TOKEN 环境变量", file=sys.stderr)
        return 1

    print("拉取 Release 附件清单 …")
    rel = api(f"/repos/{OWNER}/{REPO}/releases/tags/{TAG}", token)
    assets = {a["name"]: a for a in rel.get("assets", [])}
    print(f"线上附件数 = {len(assets)}\n")

    rows, bad = [], 0
    for name, relpath in LOCAL.items():
        p = os.path.join(LOCAL_DIR, relpath.replace("/", os.sep))
        if not os.path.isfile(p):
            rows.append((name, "本地缺失", "-", "-", "❌"))
            bad += 1
            continue
        lsize = os.path.getsize(p)
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        lsha = h.hexdigest()

        a = assets.get(name)
        if not a:
            rows.append((name, f"{lsize:,}", lsha[:12], "线上没有", "❌"))
            bad += 1
            continue

        rsize = a["size"]
        digest = (a.get("digest") or "")
        ok = (rsize == lsize)
        # 如果 GitHub 给了 digest（sha256:...）就一起比
        if ok and digest.startswith("sha256:"):
            ok = digest.split(":", 1)[1].lower() == lsha
        rows.append((name, f"{lsize:,}", lsha[:12], f"{rsize:,}" + ("" if ok else "  ← 不一致"), "✅" if ok else "❌"))
        if not ok:
            bad += 1

    w = max(len(r[0]) for r in rows)
    print(f"{'附件'.ljust(w)}  {'本地大小':>14}  {'本地sha256':<12}  线上大小")
    print("-" * (w + 42))
    for n, ls, sh, rs, mark in rows:
        print(f"{mark} {n.ljust(w)}  {ls:>14}  {sh:<12}  {rs}")

    # 多余的附件（本地没有、线上还挂着）
    extra = [n for n in assets if n not in LOCAL]
    if extra:
        print(f"\n⚠️ 线上还挂着 {len(extra)} 个不在预期内的附件: {', '.join(extra)}")

    print(f"\n结论：{len(LOCAL) - bad}/{len(LOCAL)} 一致" + ("" if bad == 0 else f"，{bad} 项不一致"))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
