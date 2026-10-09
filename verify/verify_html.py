# -*- coding: utf-8 -*-
"""校验一份「纯静态 HTML 清单」的结构完整性。

起因：这一版清单我改了好几轮，改到第 5 版时校验脚本报「少一个 </td>」，
查下来是**校验器自己的 bug** —— 连续踩了三次同一类假报警：
  ① `<tr class="done">` 带属性 → `<tr>` 精确匹配漏掉整行
  ② `<th>` 表头行本来就没有 `<td>` → 列数 0 != 表头列数
  ③ `rowspan="3"` 合并单元格 → 后两行视觉上占 3 列，源码里只有 2 个 `<td>`

**教训和 `has_payload()` 那次是同一个**：一个「看起来在检查正确性」的判据，
如果它自己没被验证过，它报出来的错比不报更糟 —— 会让人去修本来没坏的代码。
所以这个脚本自己也带自检（`--self-test`），拿已知的坏样本验证「它能报出真错」。

用法：
    python verify_html.py 磁盘清理清单.html            # 校验
    python verify_html.py --self-test                  # 先证明校验器本身可信
"""
import re
import sys

# 关键：这些正则都必须允许属性（(?:\s[^>]*)?），否则 <tr class=x> / <td class=sz> 全漏
# ⚠️ 不要用 `<tr...>.*?</tr>` 来找行！
#    在 re.S 下它对「一行里含 rowspan 的 td」会贪婪跨到下一个 </tr>，
#    把两行并成一段 → 报出「本行 2 个 td / rowspan 占位 2」这种自相矛盾的数字。
#    （这个 bug 让我一度以为 rowspan 语义搞反了，其实是匹配器坏了。）
#    正确做法：先用非贪婪切出 tr 块，再在**不含 <tr 的前提下**逐个切 td。
TR = re.compile(r"<tr(?:\s[^>]*)?>(?:(?!<tr[\s>]).)*?</tr>", re.S)
TD_OPEN = re.compile(r"<td(?:\s[^>]*)?>")
TH_OPEN = re.compile(r"<th(?:\s[^>]*)?>")
ROWSPAN = re.compile(r'rowspan\s*=\s*["\']?(\d+)')
# ⚠️ 别把 <br> / <img> 放进 TAG：它们是 XHTML 风格的自闭合标签，
#    本来就没有 </br>，放进来会永远报「开 29 / 闭 0」——纯假报警。
TAG = re.compile(r"<(html|head|body|style|div|table|thead|tbody|tr|td|th|p|h1|h2|span|code|b|em|strong|i|u|title|ul|ol|li|a)\b")


def row_cells(row_html):
    """返回这一行的 (单元格数, 最后一个单元格声明的 rowspan)。

    ⚠️ rowspan 的正确语义（我一开始理解反了，被自检抓出来）：
       `<td rowspan="3">` 表示这个单元格**跨 3 个表格行**，
       但它在**列方向上仍然只占 1 列**。
       → 所以第 2 行有 3 个 td（3 列），第 3、4 行因为第 3 列被 rowspan 占着，
         源码里**只写 2 个 td**，视觉上却是完整的 3 列。
       → 判据：后续行的「逻辑列数」= 自己的 td 数 + 被 rowspan 占掉的列数 = ncol。
         **不需要**在 rowspan 那一行额外加列（加了会多算，被我第一版写错过）。
    """
    tds = TD_OPEN.findall(row_html)
    spans = [int(x) for x in ROWSPAN.findall(row_html)]
    return len(tds), (spans[-1] if spans else 0)


def check_table(tbl, base_line, problems):
    """检查一张表：标签配对 + 每行逻辑列数是否等于表头列数。"""
    th = re.search(r"<thead>.*?</thead>", tbl, re.S)
    ncol = len(TH_OPEN.findall(th.group(0))) if th else 0

    n_td = len(TD_OPEN.findall(tbl))
    n_close = len(re.findall(r"</td>", tbl))
    if n_td != n_close:
        problems.append(f"表@行{base_line}: <td> {n_td} 个但 </td> {n_close} 个")

    n_tr = len(re.findall(r"<tr(?:\s[^>]*)?>", tbl))
    n_tr_close = len(re.findall(r"</tr>", tbl))
    if n_tr != n_tr_close:
        problems.append(f"表@行{base_line}: <tr> {n_tr} 个但 </tr> {n_tr_close} 个")

    # carry = 还需要往下延续几行（每个这样的行会少写 1 个 td）
    carry_left = 0
    for r in TR.finditer(tbl):
        seg = r.group(0)
        line = base_line + tbl[: r.start()].count("\n")
        if "<th" in seg:          # 表头行，跳过
            continue
        ncell, nspan = row_cells(seg)
        # 逻辑列数 = 自己写的 td + 被上方合并单元格占掉、因此没写的那 1 列
        logical = ncell + (1 if carry_left > 0 else 0)
        if logical != ncol:
            problems.append(
                f"表@行{line}: 逻辑列数 {logical} != 表头 {ncol}"
                f"（本行 {ncell} 个 td, 上方 rowspan 占位 {1 if carry_left>0 else 0}）"
            )
        if carry_left > 0:
            carry_left -= 1
        # 本行声明的 rowspan="n" 还会往下吃掉 n-1 行
        if nspan > 1:
            carry_left = nspan - 1
    return ncol


def validate(path):
    html = open(path, encoding="utf-8").read()
    problems = []

    # 1) 逐表检查
    for i, m in enumerate(re.finditer(r"<table>.*?</table>", html, re.S), 1):
        base = html[: m.start()].count("\n") + 1
        ncol = check_table(m.group(0), base, problems)
        print(f"  表{i} @行{base:<4d} {ncol} 列")

    # 2) 全局标签配对（table/tr/td 已单独查过，这里查剩下的）
    opens, closes = {}, {}
    for t in TAG.findall(html):
        opens[t] = opens.get(t, 0) + 1
    for t in re.findall(r"</(\w+)>", html):
        closes[t] = closes.get(t, 0) + 1
    for t in sorted(set(opens) | set(closes)):
        if t in ("table", "tr", "td", "th"):
            continue        # 已按表逐一查过，含 rowspan 逻辑
        if opens.get(t, 0) != closes.get(t, 0):
            problems.append(f"<{t}> 开 {opens.get(t,0)} / 闭 {closes.get(t,0)}")

    return problems, html


# ---------------------------------------------------------------- 自检样本
GOOD = """<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
<tbody><tr><td>1</td><td>2</td><td rowspan="3">长说明</td></tr>
<tr><td>x</td><td>y</td></tr><tr><td>p</td><td>q</td></tr></tbody></table>
<div><p class="k">带属性的标签</p><span>行内</span></div>"""

BAD_CASES = {
    # ⚠️ 写这个自检时我第一版把「少一个 </td>」的样本写成了标签配平的样子
    #    （两边都是 2），判据正确地没报警报 → 看起来像校验器坏了。
    #    真相是**样本本身是好的**。这正是自检的价值：它分得清
    #    「校验器坏了」和「样本写错了」。样本必须是真坏的。
    "少一个 </td>": '<table><thead><tr><th>A</th><th>B</th></tr></thead>'
                    '<tbody><tr><td>1</td><td>2</tr></tbody></table>',
    "列数对不上":   '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>'
                    '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    "div 未闭合":   '<table><thead><tr><th>A</th></tr></thead>'
                    '<tbody><tr><td>1</td></tr></tbody></table><div><p>没关</div>',
    "tr 少闭合":    '<table><thead><tr><th>A</th><th>B</th></tr></thead>'
                    '<tbody><tr><td>1</td><td>2</td></tbody></table>',
}


def self_test():
    """证明这个校验器能报出真错 —— 否则它的「通过」没有意义。"""
    print("自检 1：已知正确的样本（含 rowspan / 带 class 的标签）应通过")
    probs, _ = validate_str(GOOD)
    print(f"  {'OK ' if not probs else 'BAD'} 无问题 = {not probs}")
    if probs:
        for p in probs:
            print("     ", p)
        return False

    print("自检 2：已知错误的样本必须被抓到")
    ok = True
    for name, sample in BAD_CASES.items():
        probs, _ = validate_str(sample)
        got = len(probs) > 0
        ok &= got
        print(f"  {'OK ' if got else 'BAD'} 「{name}」-> {len(probs)} 条: {probs[:1]}")

    print(f"\n{'★ 校验器本身可信' if ok else '*** 校验器有 bug，它报的错不可信 ***'}")
    return ok


def validate_str(html):
    """给字符串版（自检用），逻辑与 validate 相同。"""
    problems = []
    for m in re.finditer(r"<table>.*?</table>", html, re.S):
        check_table(m.group(0), html[: m.start()].count("\n") + 1, problems)
    opens = {}
    for t in TAG.findall(html):
        opens[t] = opens.get(t, 0) + 1
    closes = {}
    for t in re.findall(r"</(\w+)>", html):
        closes[t] = closes.get(t, 0) + 1
    for t in sorted(set(opens) | set(closes)):
        if t in ("table", "tr", "td", "th"):
            continue
        if opens.get(t, 0) != closes.get(t, 0):
            problems.append(f"<{t}> 开 {opens.get(t,0)} / 闭 {closes.get(t,0)}")
    return problems, html


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(0 if self_test() else 1)
    target = sys.argv[1] if len(sys.argv) > 1 else "磁盘清理清单.html"
    print(f"校验 {target}")
    probs, html = validate(target)
    print(f"  字节数 {len(html.encode('utf-8'))}")
    if probs:
        print(f"\n❌ {len(probs)} 个问题:")
        for p in probs:
            print("   -", p)
        sys.exit(1)
    print("\n✅ 结构检查通过")
