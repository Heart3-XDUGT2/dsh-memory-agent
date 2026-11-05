# -*- coding: utf-8 -*-
"""A8:联想对照台 —— 同一判据下的**改造前 / 改造后**读数 + 既有检索台不退化断言。

一份一句:改造前(v1)= 只有**事实边**可走(1~2 跳 BFS,这是 v2 之前引擎里唯一的联想源);
改造后(v2)= **证据层**图上的只读 PPR(含 hub 降权 + hub 不进排名 + 时间邻近只做候选)。
两者量**同一个判据**:"种子概念的**同证据兄弟**有没有被联想捞到"。

判据是**机械**的,不靠人写答案:
  `siblings(S)` = 与 S **共享至少一条证据行**的概念集合(证据行 = 一条记忆 / 一天里
  一起出现过的那组概念)。v1 那边这个集合**照样算**——只是 v1 的联想源看不见它,
  这正是架构改动要说的那件事。

三个读数(都会印出来):
  ① 12 题小样本:S = 图上证据最足的概念;每题的 `v1 命中 / v2 命中 / 兄弟数`;
  ② 真提问抽样:`audit_logs` 里最近的真实用户提问(滤掉工具帧)⇒ 命中率;
  ③ 既有检索台逐档对照(`--tiers <现在的输出> --baseline <上次留的档>`)⇒ 任一项退化即退出码 1。

用法(在 dsh-echo 根目录):
    python scripts/assoc-bench.py --db .scratch/rehearsal/a7.db
    python scripts/assoc-bench.py --db <库> --json --report .scratch/a8-assoc.md
    python scripts/assoc-bench.py --tiers .scratch/now.txt --baseline .scratch/a6-bench-baseline.txt

⚠️ 只读:本脚本一个字都不写(它没有任何写开关)。
"""

import argparse
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "python"))

from engine import cooc as cooc_mod       # noqa: E402
from engine import db as db_mod           # noqa: E402
from engine import ppr as ppr_mod         # noqa: E402

SAMPLE_SIZE = 12
TOP_K = 6
HUB_MAX_DEG = ppr_mod.HUB_RANK_MAX_DEG
MEM_PREFIX = ppr_mod.MEM_PREFIX

#: 检索台逐档行:`R0现状  0.135  0.000  6  0.0%  14`
TIER_RE = re.compile(
    r"^\s*(R\d\S*)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9]+)\s+([0-9.]+)%\s+([0-9]+)\s*$")
#: 越大越好的三项 / 越小越好的两项(退化 = 前者降 or 后者升)
TIER_UP = ("mrr@10", "ndcg@5", "seh@3")
TIER_DOWN = ("首答位次中位", "装下k中位")


# ── 判据(机械金标)────────────────────────────────────────────────────────────

def sibling_map(conn, *, cooc_owner=cooc_mod.COOC_OWNER):
    """`概念 → 与它共享过证据行的概念集合`(没有证据层就是空表 —— v1 那边也照算)。"""
    out = {}
    try:
        rows = conn.execute("SELECT node_ids FROM " + cooc_mod.EVIDENCE_TABLE +
                            " WHERE owner_key = ?", (cooc_owner,)).fetchall()
    except Exception:
        rows = []
    for (ids,) in rows:
        parts = sorted({p.strip() for p in str(ids or "").split("、") if p.strip()})
        for a in parts:
            for b in parts:
                if a != b:
                    out.setdefault(a, set()).add(b)
    return out


def v1_reachable(conn, seed, *, hops=2, budget=None):
    """**改造前**的联想源:只有事实边(1~2 跳 BFS)。

    `budget` = 与 v2 同一个出量上限(老引擎那条路也是**有上限**的激活,不是无限集合):
    按跳数近的先来,同跳按度数大的先,再按名字定序 —— 这样 v1 与 v2 是**同一个预算**下比。
    """
    adj = {}
    try:
        rows = conn.execute(
            "SELECT source_id, target_id FROM graph_edges"
            " WHERE COALESCE(kind, '') = '' AND COALESCE(is_active, 1) = 1").fetchall()
    except Exception:
        rows = []
    for s, t in rows:
        adj.setdefault(str(s), set()).add(str(t))
        adj.setdefault(str(t), set()).add(str(s))
    dist = {seed: 0}
    frontier = [seed]
    for d in range(1, max(1, int(hops)) + 1):
        nxt = []
        for u in frontier:
            for v in sorted(adj.get(u, ())):
                if v not in dist:
                    dist[v] = d
                    nxt.append(v)
        frontier = nxt
        if not frontier:
            break
    if budget is None:
        return {u for u in dist if u != seed}
    deg = {u: len(adj.get(u, ())) for u in dist}
    order = sorted((u for u in dist if u != seed),
                   key=lambda u: (dist[u], -deg.get(u, 0), str(u)))
    return set(order[:int(budget)])


def v2_topk(conn, seed, *, k=TOP_K, hub_max_deg=HUB_MAX_DEG):
    """**改造后**的联想源:证据层上的 PPR(hub 不进排名)。"""
    g = ppr_mod.build_graph(conn)
    if seed not in g["adj"]:
        return []
    run = ppr_mod.run_ppr(g, [seed])
    ranked = [n for n, _v in sorted(run["scores"].items(), key=lambda kv: (-kv[1], kv[0]))
              if n != seed and not str(n).startswith(MEM_PREFIX)
              and float(run["deg"].get(n, 0)) < float(hub_max_deg)]
    return ranked[:int(k)]


def sample_seeds(conn, *, size=SAMPLE_SIZE, hub_max_deg=HUB_MAX_DEG):
    """样本 = 图上**证据最足**的概念(按"兄弟数"排序;hub 除外) —— 机械选,不挑好看的。"""
    sib = sibling_map(conn)
    names = {str(r[0]): str(r[1] or r[0]) for r in conn.execute(
        "SELECT node_id, name FROM graph_nodes")}
    g = ppr_mod.build_graph(conn)
    deg = {u: sum(float(w) for w in g["adj"][u].values()) for u in g["adj"]}
    picked = [n for n in sorted(sib, key=lambda n: (-len(sib[n]), str(names.get(n, n))))
              if float(deg.get(n, 0)) < float(hub_max_deg)]
    return picked[:int(size)], sib, names


# ── ①② 两个读数 ─────────────────────────────────────────────────────────────

def sample_section(conn, *, size=SAMPLE_SIZE, seeds_path=None):
    """样本 = 图上**证据最足**的概念(机械选)。`seeds_path` 里已经记着样本就**用它**:

    样本是按图上的度数排的,**图一变样本就会换**(A1 恢复 5 条边之后我实测样本从 12/66
    变成了 12/61)—— 那就不是对照了。所以 before/after 必须**钉同一份样本**。
    """
    seeds, sib, names = sample_seeds(conn, size=size)
    seeded_from = "本库现选"
    if seeds_path:
        try:
            with open(seeds_path, encoding="utf-8") as fh:
                pinned = json.load(fh)
            ids = [str(x) for x in (pinned.get("ids") or [])]
            if ids:
                seeds, seeded_from = ids, "钉住的样本(%s)" % os.path.basename(seeds_path)
        except Exception:
            pass
        if seeded_from == "本库现选":
            with open(seeds_path, "w", encoding="utf-8") as fh:
                json.dump({"ids": seeds, "names": [names.get(s, s) for s in seeds],
                           "rule": "按证据兄弟数降序、hub(deg≥%d)除外,取前 %d"
                                   % (HUB_MAX_DEG, size)}, fh, ensure_ascii=False, indent=2)
            seeded_from = "本库现选 → 已写进 %s(下次照着钉)" % os.path.basename(seeds_path)

    items = []
    hits = {"v1_set": 0, "v1_k": 0, "v2_k": 0}
    total = 0
    for seed in seeds:
        want = set(sib.get(seed) or ())
        got_set = v1_reachable(conn, seed)
        got_k = v1_reachable(conn, seed, budget=TOP_K)
        got2 = set(v2_topk(conn, seed))
        total += len(want)
        hits["v1_set"] += len(want & got_set)
        hits["v1_k"] += len(want & got_k)
        hits["v2_k"] += len(want & got2)
        items.append({"seed": names.get(seed, seed), "siblings": len(want),
                      "v1_set_hit": len(want & got_set), "v1_k_hit": len(want & got_k),
                      "v2_k_hit": len(want & got2),
                      "v2_topk": [names.get(x, x) for x in list(got2)[:TOP_K]],
                      "v1_set_size": len(got_set)})
    den = total or 1
    return {"size": len(items), "sibling_total": total, "seeded_from": seeded_from,
            "hits": hits,
            "v1_set_rate": round(hits["v1_set"] / den, 4),
            "v1_k_rate": round(hits["v1_k"] / den, 4),
            "v2_k_rate": round(hits["v2_k"] / den, 4),
            "items": items,
            "rule": "判据:与种子**共享至少一条证据行**的概念;v1 = 事实边 1~2 跳"
                    "(老引擎那条路也有上限,所以另给一个 top%d 的同预算读数);"
                    "v2 = 证据层 PPR top%d(hub 不进排名)" % (TOP_K, TOP_K)}


def questions_section(conn, *, limit=SAMPLE_SIZE):
    """真提问抽样(滤掉工具帧与系统行)—— 与 A6 同一套过滤,这里只报命中率。"""
    items, hit, paths = [], 0, 0
    try:
        rows = conn.execute(
            "SELECT COALESCE(user_input, '') FROM audit_logs"
            " WHERE COALESCE(user_input, '') <> '' AND user_input NOT LIKE '(%'"
            "   AND user_input NOT LIKE '%structured_output%'"
            "   AND user_input NOT LIKE '%[标签%'"
            " ORDER BY timestamp DESC LIMIT ?", (int(limit),)).fetchall()
    except Exception:
        rows = []
    for (text,) in rows:
        st = ppr_mod.report(conn, query=text, top=TOP_K)
        ok = bool(st["seeds"])
        hit += 1 if ok else 0
        paths += 1 if st["paths"] else 0
        items.append({"q": str(text)[:48], "hit": ok, "seeds": st["seed_names"],
                      "top": [r["name"] for r in st["ranking"][:3]]})
    return {"asked": len(items), "hit": hit, "with_path": paths, "items": items}


# ── ③ 既有检索台逐档不退化 ──────────────────────────────────────────────────

def parse_tiers(path):
    out = {}
    with open(path, encoding="utf-8-sig", errors="replace") as fh:
        for line in fh:
            m = TIER_RE.match(line.rstrip("\n"))
            if m:
                out[m.group(1)] = {"mrr@10": float(m.group(2)), "ndcg@5": float(m.group(3)),
                                   "首答位次中位": int(m.group(4)),
                                   "seh@3": float(m.group(5)), "装下k中位": int(m.group(6))}
    return out


def tier_deltas(now_path, baseline_path):
    now, base = parse_tiers(now_path), parse_tiers(baseline_path)
    rows, regressed = [], []
    for route in sorted(set(base) | set(now)):
        b, n = base.get(route), now.get(route)
        if b is None or n is None:
            rows.append({"route": route, "status": "missing", "note":
                         "基线里没有" if b is None else "这一跑里没有"})
            continue
        delta = {k: round(float(n[k]) - float(b[k]), 4) for k in b}
        bad = ([k for k in TIER_UP if delta[k] < 0] + [k for k in TIER_DOWN if delta[k] > 0])
        rows.append({"route": route, "status": "regressed" if bad else "ok",
                     "delta": delta, "worse": bad})
        if bad:
            regressed.append(route)
    return {"rows": rows, "regressed": regressed,
            "ok": not regressed and not any(r["status"] == "missing" for r in rows)}


def to_text(rep):
    out = ["== A8 联想对照台(改造前 vs 改造后;同一机械判据)=="]
    s = rep["sample"]
    if s.get("skipped"):
        # --tiers 模式只比两份**留档的检索台输出**,不连库 ⇒ ①② 两节在这一步不适用。
        # (以前这里塞的是硬编码的 0,读起来像"样本掉了" —— 2026-10-02 上真库时我把
        #  自己的输出看岔过一次,所以改成明说"不适用"。)
        out.append("① 12 题小样本、② 真提问抽样:**本模式不适用**(--tiers 只比留档检索台;"
                   "这两节要连库跑 `--db`)")
    else:
        hits, tot = s["hits"], s["sibling_total"] or 1
        out.append("① 12 题小样本(样本 %d,兄弟总数 %d;样本来源:%s):"
                   % (s["size"], s["sibling_total"], s.get("seeded_from", "本库现选")))
        out.append("   v1(事实边,集合) %d/%d(%.1f%%) | v1(事实边,同预算 top6) %d/%d(%.1f%%)"
                   " | v2(证据层 PPR top6) %d/%d(%.1f%%)"
                   % (hits["v1_set"], tot, 100.0 * s["v1_set_rate"],
                      hits["v1_k"], tot, 100.0 * s["v1_k_rate"],
                      hits["v2_k"], tot, 100.0 * s["v2_k_rate"]))
        for it in s["items"]:
            out.append("   %-16s 兄弟 %-2d v1集合 %-2d v1@6 %-2d v2@6 %-2d | v2 联想:%s"
                       % (it["seed"][:16], it["siblings"], it["v1_set_hit"], it["v1_k_hit"],
                          it["v2_k_hit"], "、".join(it["v2_topk"][:4])))
        q = rep["questions"]
        out.append("② 真提问抽样:%d 条里命中 %d 条、有可解释路径 %d 条"
                   % (q["asked"], q["hit"], q["with_path"]))
        for it in q["items"]:
            if it["hit"]:
                out.append("   %-26s → %s" % (it["q"][:26], "、".join(it["top"])))
    if rep.get("tiers"):
        t = rep["tiers"]
        out.append("③ 既有检索台逐档:%s" % ("**全档不退**" if t["ok"] else
                                        "⚠️ 退化:" + "、".join(t["regressed"])))
        for r in t["rows"]:
            if r["status"] == "ok":
                out.append("   %-10s OK Δ=%s" % (r["route"], json.dumps(r["delta"], ensure_ascii=False)))
            else:
                out.append("   %-10s %s %s" % (r["route"], r["status"],
                                               r.get("worse") or r.get("note") or ""))
    out.append("   · 只读:本脚本不写任何表(它没有任何写开关)")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="A8 联想对照台(只读)")
    ap.add_argument("--db", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default=None)
    ap.add_argument("--seeds", default=os.path.join(REPO, ".scratch", "assoc-seeds.json"),
                    help="样本钉在哪个文件里(before/after 必须同一份;没有就现选并写下来)")
    ap.add_argument("--tiers", default=None, help="现在的检索台输出文件")
    ap.add_argument("--baseline", default=os.path.join(REPO, ".scratch", "a6-bench-baseline.txt"),
                    help="上次留档的检索台输出(默认 A6 那份)")
    args = ap.parse_args(argv)

    if args.tiers:
        d = tier_deltas(args.tiers, args.baseline)
        text = to_text({"sample": {"skipped": True},
                        "questions": {"asked": 0, "hit": 0, "with_path": 0, "items": []},
                        "tiers": d})
        print(json.dumps(d, ensure_ascii=False, indent=2) if args.json else text)
        return 0 if d["ok"] else 1

    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        rep = {"db": path, "sample": sample_section(conn, seeds_path=args.seeds),
               "questions": questions_section(conn)}
        text = to_text(rep)
        if args.report:
            with open(args.report, "w", encoding="utf-8") as fh:
                fh.write("# A8 联想对照台\n\n库:`%s`\n\n%s\n" % (path, text))
        print(json.dumps(rep, ensure_ascii=False, indent=2) if args.json
              else "库 %s\n%s" % (path, text))
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
