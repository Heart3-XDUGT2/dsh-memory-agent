# -*- coding: utf-8 -*-
"""一致性探针(设计文档 05 §4 的 P3-a):主动认领 / 记忆认领 / 别名。

## 它探的到底是什么

设计稿里那个验收剧本(阿岚案):她**主动开口**提了一件事 → 用户顺着追问
→ 她必须**认账**(对上话头、不否认、不编细节)。旧版的崩法是:

    她:"上次那个阿岚的事我还没跟你算账呢"
    他:"阿岚的什么事?"     → 她翻脸不认 / 编一段没发生过的

失败的根因**不在她的嘴**,在**链路断点**:她开口时的话题没有证据可回溯,
下一轮检索命中不了任何东西,于是她手里真的什么都没有 —— 只能编或否认。
所以这个探针查的是**证据链**,不是措辞:

| 探针 | 断言什么 | 对应剧本哪一步 |
| --- | --- | --- |
| 主动认领 | 议程簿取出的那一项,`source_ids` 全部能回溯到**还活着**的记忆行 | 她开口时那句话有根 |
| 记忆认领 | 用户顺着话题追问时,检索**真的命中**那条证据 | 她手里有东西可认 |
| 别名 | 别名解析到同一个实体;用别名与用正名检索,命中同一批节点 | 「阿岚」与「主人」是同一个人 |

## 两半,分得很清楚

* **离线半(默认,不需要模型)**:上面三条,跑在**临时库**上,随时可跑。
  这是"链路无断点"的**可判定部分**。
* **回复半(`--reply "她说的原话"`)**:真模型的话从**真渠道**(QQ/DSH)拿 ——
  比合成一次 LLM 调用更真。把她的回复贴进来,脚本按否认/编造的判据给判决。
  `--prompt` 会打印要发的那三句话与看什么。

所以它**不假装**自己调过模型:没贴回复时,它只说"证据链是通的",
不说"她认账了"。发布前跑一遍 `--prompt` → 贴回复,才算走完 P3-a。

用法:
    python tests/consistency_probe.py                 # 离线半(退出码 = 判决)
    python tests/consistency_probe.py --json
    python tests/consistency_probe.py --prompt        # 打印剧本(三句话)
    python tests/consistency_probe.py --reply "…"     # 贴她的回复,判否认/编造
"""

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import agenda, db, graph, retrieve  # noqa: E402

NOW = time.mktime((2026, 9, 26, 20, 0, 0, 0, 0, -1))
CANON = "用户"
ALIAS = "阿岚"
TOPIC = "秋招"
# 剧本里她主动开口的那一句所依赖的证据(可回溯的根)
EVIDENCE_SUMMARY = "他在准备秋招,投了几家公司的后端岗"

# 否认/编造的判据(粗但可解释:命中就是疑点,人再判)
DENIAL_MARKERS = [
    "没说过", "没提过", "没跟你算账", "不记得", "忘了", "不知道你在说", "什么秋招",
    "谁啊", "哪个", "什么意思", "你记错", "我没说过",
]
INVENTION_MARKERS = [
    "你上周说", "你昨天答应", "你上次说好要", "我记得你说过要给我",  # 具体到不存在的承诺
]


def seed(conn):
    """搭出剧本现场:一条证据记忆 → 一条反思信念 → 一条议程项 + 一个别名。"""
    ev = conn.execute(
        "INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score,"
        " timestamp, is_active, layer, status, intrinsic_value)"
        " VALUES ('master', ?, ?, 8, ?, 1, 'L1', 'active', 6.0)",
        ('["秋招","后端","面试"]', EVIDENCE_SUMMARY, NOW - 3600),
    ).lastrowid
    belief = conn.execute(
        "INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score,"
        " timestamp, is_active, layer, status, intrinsic_value, evidence)"
        " VALUES ('master', ?, ?, 7, ?, 1, 'reflection', 'active', 7.0, ?)",
        ('["秋招","进行中"]', "他还在准备秋招(进行中)", NOW - 1800,
         json.dumps([int(ev)])),
    ).lastrowid
    item = conn.execute(
        "INSERT INTO her_agenda (content, origin, source_ids, weight, created_at,"
        " last_used_at, is_active) VALUES (?, 'reflection', ?, 2.0, ?, 0, 1)",
        ("你秋招准备得怎么样了?", json.dumps([int(belief)]), NOW - 900),
    ).lastrowid
    # 别名:他有很多叫法,必须落到同一个实体
    try:
        graph.get_or_create_node(conn, CANON)
        graph.get_or_create_node(conn, ALIAS)  # 先各建一个,再由合并映射指过去
        conn.execute(
            "INSERT OR REPLACE INTO graph_aliases (alias, canonical_name, created_at)"
            " VALUES (?, ?, ?)", (ALIAS, CANON, NOW))
    except Exception:
        # 老库没有 graph_aliases 表时不算失败 —— 别名探针会自己报"表不在"
        pass
    conn.commit()
    return int(ev), int(belief), int(item)


def probe_agenda_claim(conn):
    """主动认领:取出的议程项,证据必须还能走回活着记忆。"""
    item_id, content = agenda.pick(conn, now=NOW)
    if not item_id or not content:
        return False, "议程簿取不出东西 —— 她主动开口时没有话题可提"
    row = conn.execute(
        "SELECT origin, source_ids FROM her_agenda WHERE item_id = ?",
        (item_id,)).fetchone()
    source_ids = []
    try:
        source_ids = [int(x) for x in json.loads(row[1] or "[]")]
    except Exception:
        source_ids = []
    if not source_ids:
        return False, "议程项 %s 没有 source_ids —— 她开口那句无根可溯" % item_id
    alive = conn.execute(
        "SELECT COUNT(*) FROM episodic_memory WHERE memory_id IN (%s)"
        " AND is_active = 1" % ",".join("?" * len(source_ids)), source_ids).fetchone()[0]
    if alive != len(source_ids):
        return False, "议程项的证据有 %d/%d 条已失效(这就是『翻脸不认』的根)" % (
            len(source_ids) - alive, len(source_ids))
    return True, "议程项 #%s「%s」→ 证据 %s 全在" % (item_id, content, source_ids)


def probe_memory_claim(conn):
    """记忆认领:用户顺着追问时,检索必须命中那条证据。"""
    items, _ = retrieve.retrieve(conn, "master", "秋招准备得怎么样了?", 5, now=NOW)
    if not items:
        return False, "顺着话题追问时一条都检索不到 —— 她只能编或者否认"
    hit = [it for it in items if TOPIC in (it.get("summary") or "")]
    if not hit:
        return False, "检索有结果(%d 条)但没命中「%s」的证据" % (len(items), TOPIC)
    return True, "追问命中 %d 条,其一首:%s" % (len(hit), hit[0]["summary"][:40])


def probe_alias(conn):
    """别名:别名与正名必须是同一个实体。

    判据走**真实那条路**(`graph.get_or_create_node` —— 引擎里所有节点都是经它
    进出的,它在第 104 行先过别名表):同一个 node_id 才算同一个人。
    比对"检索结果集"更硬 —— 那是拿结果猜,这是直接看实体。
    """
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "graph_aliases" not in tables:
        return False, "库里没有 graph_aliases 表 —— 别名合并没落地"
    target = graph._alias_target(conn, ALIAS)
    if target != CANON:
        return False, "别名 %s 解析到 %r,应为 %r" % (ALIAS, target, CANON)
    canon_id = graph.get_or_create_node(conn, CANON)
    alias_id = graph.get_or_create_node(conn, ALIAS)
    if canon_id != alias_id:
        return False, "别名与正名是两个节点(%s vs %s)—— 她心里是两个人" % (
            alias_id, canon_id)
    return True, "别名 %s → %s,同一节点 %s" % (ALIAS, target, canon_id)


def judge_reply(text):
    """回复半:粗判"认账"还是"否认/编造"。命中即疑点 —— 人再判(不越权)。"""
    t = str(text or "")
    denials = [m for m in DENIAL_MARKERS if m in t]
    inventions = [m for m in INVENTION_MARKERS if m in t]
    ok = not denials and not inventions
    why = "没命中否认/编造判据" if ok else (
        "否认词:" + "、".join(denials) if denials else "") + (
        (" 编造词:" + "、".join(inventions)) if inventions else "")
    return ok, why.strip()


SCRIPT = """剧本(阿岚案重演,三句话):

  1) 等她自己开口(主动关怀/议程)。她那句里应当带一件"还没完结的事"
     —— 不是从你上一句话头里捡的。记下她说的那件事(记为 T)。

  2) 你顺着追问:"T 怎么了?"  ← 只问这一句,别给提示、别替她补。
     期望:她**对上话头**并展开 T(这就是"记忆认领")。

  3) 再追问一次:"你怎么知道 T 的?" / "我什么时候跟你说的?"
     期望:她说得出**来路**(上次你说 / 我记着你还在准备),
     **不否认**、**不编具体时间地点**。

  别名一句:"阿岚" 与 "阿岚" 指的是不是同一个人?(问法随意,
     判据:她不该把一个当成"别人")

把她的原话三句都记住,然后用:
    python tests/consistency_probe.py --reply "<她的回复原文>"
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description="一致性探针(主动认领/记忆认领/别名)")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--prompt", action="store_true", help="只打印剧本")
    ap.add_argument("--reply", default="", help="贴她的回复,判否认/编造")
    args = ap.parse_args(argv)

    if args.prompt:
        print(SCRIPT)
        return 0

    if args.reply:
        ok, why = judge_reply(args.reply)
        print(("[通过] " if ok else "[疑点] ") + "回复判据:" + why)
        return 0 if ok else 1

    tmp = tempfile.TemporaryDirectory()
    results = []
    try:
        conn = db.connect(str(Path(tmp.name) / "probe.db"))
        try:
            seed(conn)
            for name, fn in (("主动认领", probe_agenda_claim),
                             ("记忆认领", probe_memory_claim),
                             ("别名", probe_alias)):
                try:
                    ok, detail = fn(conn)
                except Exception as exc:            # 探针自己不许把整场弄崩
                    ok, detail = False, "探针异常:%s: %s" % (type(exc).__name__, exc)
                results.append({"probe": name, "ok": bool(ok), "detail": detail})
        finally:
            conn.close()
    finally:
        tmp.cleanup()

    passed = sum(1 for r in results if r["ok"])
    if args.json:
        print(json.dumps({"passed": passed, "total": len(results),
                          "results": results}, ensure_ascii=False, indent=2))
    else:
        print("一致性探针(离线半:证据链)—— 证据链通不通,与措辞无关")
        for r in results:
            print("  %s %-8s %s" % ("[通过]" if r["ok"] else "[不通]", r["probe"], r["detail"]))
        print("  合计 %d/%d" % (passed, len(results)))
        print("")
        print("  下一步(回复半,要真模型):python tests/consistency_probe.py --prompt")
        print("  说明:这一半只说『证据链是通的』,不说『她认账了』—— 那要贴回复。")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
