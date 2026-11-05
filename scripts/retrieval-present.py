# -*- coding: utf-8 -*-
"""呈现层 / 生成端量台(L4) —— 检索之后那一段,终于有尺子。

为什么需要它(见 docs/MEMORY_ARCH_DESIGN.md §3、§2-L4):
    现有量台只到"排序"为止。而公开证据里**最大单项增益在呈现层**
    (CPP:两个条件的 Recall@k/Hit@k/MRR **逐项相同**,答对率仍 +3.4pp;
     单项最大增益 = 证据高亮 +26.3pp,且不多给一个字)。
    ⇒ 呈现层改的是"喂给模型的东西",它的效果**只能从最终答案上看出来**。
    没有这一段,呈现层改完就是"凭感觉"。

这一跑量什么:
    * 把候选**装配**成上下文(5 种装配变体:现状顺序 / 证据放两端 / 证据高亮 /
      倒序 / 乱序),交给一个**消费者**读,再判它答得对不对;
    * 一律报 **token 数**,并给一张**同预算**对照表(CPP 自认的最大方法论缺口:
      "少 4.8× 单元" ≠ "少字数");
    * 三个负控(必须过,否则这一跑的数不可信)。

三个负控:
    N1 空上下文 ⇒ 命中率必须 **0**(答案不可能凭空出现);
    N2 换消费者(--consumer first)⇒ 数字必须**显著变化**(证明"消费者"这一环真的在起作用);
    N3 乱序 vs 现状顺序 ⇒ 在**离线抽取式消费者**下必须**逐字相同**
       (抽取式消费者按构造对位置不敏感 ⇒ 这条同时是个**标定事实**:
        **位置效应它测不了,只能由 LLM 消费者测**)。

用法:
    python scripts/retrieval-present.py                    # 离线:抽取式消费者
    python scripts/retrieval-present.py --consumer first    # 消费者负控
    python scripts/retrieval-present.py --llm-endpoint URL --llm-key KEY \
        --llm-model deepseek-chat                           # 接真模型(有出口时)
    python scripts/retrieval-present.py --dump .scratch/l4.json

边界(别过度解读):
    * 离线判定的依据是**来源**(答案取自哪条记忆)⇒ 它的"命中/误认"是**精确**的,
      但它量不到"推理/利用"层(取到了也能用错),那需要 LLM 消费者;
    * 语料是小样本,数字只能看趋势(见 docs/RETRIEVAL_BASELINE.md §6.2 快照声明)。
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import math
import os
import random
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
# 文件名带连字符 ⇒ 不能用 `import retrieval-bench`;按路径加载。
_spec = importlib.util.spec_from_file_location(
    "retrieval_bench", os.path.join(HERE, "retrieval-bench.py"))
rb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rb)

TOP_K = 5

# ---- "现在的 LLM":本机网关(~/.dsh/settings.yaml 的 llm-pi-ai.providers.jichuang-office)
# 密钥从 ~/.dsh/.credentials.yaml 的 refs 里按名字取;**只读,不打印**。
DEFAULT_ENDPOINT = "https://r.dis.115.zone/v1/chat/completions"
DEFAULT_KEY_REF = "JICHUANG_OFFICE_API_KEY"
DEFAULT_MODEL = "deepseek-v4-flash"   # deepseek-flash 实测 429;v4-flash 2.2s 可用
SYS_PROMPT = ("你是记忆问答助手。只依据给定的记忆片段回答;答不出就回答「不知道」。"
              "答案要短,直接给事实,不要解释。")

# 引用式口径:让模型**自己标出处**,判定就变成精确的来源判定(不必猜改写型答案)
SYS_PROMPT_CITE = ("你是记忆问答助手。只依据给定的记忆片段回答。\n"
                   "严格输出两行,不要别的内容:\n"
                   "答案:<简短事实;答不出就写 不知道>\n"
                   "依据:<用到的片段编号,只填数字;没用到任何片段就写 无>")

VARIANTS = [
    ("V0 现状顺序", "候选按分数原序拼"),
    ("V1 证据放两端", "最强证据放最前、次强放最后(对冲 U 型位置效应)"),
    ("V2 证据高亮", "每段末尾追加「证据: <最相关句>」(CPP 做法)"),
    ("V3 倒序", "从最弱到最强(位置负控:应当更差或持平)"),
    ("V4 乱序", "固定种子打散(位置负控)"),
]


# ---------------------------------------------------------------- 语料/金标
def bootstrap(db_path=None):
    tmpdir = None
    if not db_path:
        live = os.path.join(
            os.environ.get("DSH_HOME", os.path.join(os.path.expanduser("~"), ".dsh")),
            "echo", "echo.db")
        tmpdir = tempfile.mkdtemp(prefix="echo_present_")
        db_path = os.path.join(tmpdir, "present.db")
        for suffix in ("", "-wal", "-shm"):
            src = live if not suffix else live + suffix
            if os.path.exists(src):
                shutil.copy2(src, db_path + suffix)
    conn = sqlite3.connect("file:%s?mode=ro" % db_path.replace("\\", "/"), uri=True)
    rows = rb.load_rows(conn)
    verbatim = rb.extract_verbatim(conn)
    conn.close()
    fts_conn = rb.build_fts5(rows)
    rows_by_id = {r["memory_id"]: r for r in rows}
    bm = rb.BM25(rows)
    golden, warn = rb.build_golden(verbatim)
    return dict(tmpdir=tmpdir, db_path=db_path, rows=rows, rows_by_id=rows_by_id,
                fts_conn=fts_conn, bm=bm, golden=golden, warn=warn, fts=None)


# ---------------------------------------------------------------- token 计数
def rank_quiet(q, env, rows, rows_by_id, bm, fts_conn, now):
    """调量台的六路时**吞掉它的 stdout**(它每路都打 [RT11-R6] 之类,这里是噪音)。
    返回 (out, pool):out 是各路 top-K;pool 是各路 **POOL_K 宽的名单**(官方指标要用宽名单)。"""
    with contextlib.redirect_stdout(io.StringIO()):
        out, _times, _extra, pool = rb.rank_all_methods(
            q, rows, rows_by_id, bm, fts_conn, env["db_path"], now)
    return out, pool


# ---------------------------------------------------------------- 官方检索指标
def _dcg(rels, k):
    rels = rels[:k]
    if not rels:
        return 0.0
    return rels[0] + sum(r / math.log2(i + 2) for i, r in enumerate(rels[1:]))


def _ndcg(ranked, correct, k):
    """照抄官方 eval_utils.ndcg:relevance = 该位置是否命中。"""
    rels = [1 if mid in correct else 0 for mid in ranked]
    ideal = sorted(rels, reverse=True)
    idcg = _dcg(ideal, k)
    return (_dcg(rels, k) / idcg) if idcg > 0 else 0.0


def official_retrieval_metrics(ranked, accept, sess_of, k):
    """official 口径:recall_any / recall_all / ndcg,轮级与会话级各一套。

    会话级照抄官方 `evaluate_retrieval_turn2session`:先把候选**按会话去重**,
    再取前 k 个**不同会话**(等效于官方的 effective_k 循环)。
    """
    out = {}
    turn = ranked[:k]
    out["turn_recall_any"] = 1.0 if (set(turn) & accept) else 0.0
    out["turn_recall_all"] = 1.0 if (accept and accept <= set(turn)) else 0.0
    out["turn_ndcg_any"] = _ndcg(ranked, accept, k)
    seen, sess_rank = set(), []
    for mid in ranked:
        s = sess_of.get(mid)
        if s is not None and s not in seen:
            seen.add(s)
            sess_rank.append(s)
    want = {sess_of[m] for m in accept if m in sess_of}
    got = set(sess_rank[:k])
    out["sess_recall_any"] = 1.0 if (got & want) else 0.0
    out["sess_recall_all"] = 1.0 if (want and want <= got) else 0.0
    rels = [1 if s in want else 0 for s in sess_rank]
    ideal = sorted(rels, reverse=True)
    out["sess_ndcg_any"] = (_dcg(rels, k) / _dcg(ideal, k)) if _dcg(ideal, k) > 0 else 0.0
    return out


def load_gateway_key(ref=DEFAULT_KEY_REF):
    """从 ~/.dsh/.credentials.yaml 的 refs 里取密钥(只读;不打印、不落盘)。"""
    path = os.path.join(os.environ.get("DSH_HOME", os.path.join(os.path.expanduser("~"), ".dsh")),
                        ".credentials.yaml")
    try:
        txt = open(path, encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"(?m)^\s*%s\s*:\s*['\"]?([^\s'\"]+)" % re.escape(ref), txt)
    return m.group(1) if m else None


def build_prompt(context, query):
    return "记忆片段:\n%s\n\n问题:%s" % (context, query)


def build_cite_prompt(context, query):
    return "记忆片段:\n%s\n\n问题:%s" % (context, query)


def parse_cite(raw):
    """从"答案:/依据:"两行里取出答案与引用编号。"""
    ans, cite = "", None
    for ln in (raw or "").split("\n"):
        s = ln.strip()
        if s.startswith("答案"):
            ans = s.split(":", 1)[-1].split("：", 1)[-1].strip()
        elif s.startswith("依据"):
            t = s.split(":", 1)[-1].split("：", 1)[-1].strip()
            m = re.search(r"\d+", t)
            cite = int(m.group(0)) if m else None
    if not ans:
        ans = (raw or "").strip()
    return ans, cite


def num2id(context, prov):
    """片段编号(上下文里的 `[n]`)→ memory_id。"""
    pmap = dict(prov)
    out = {}
    for i, ln in enumerate(context.split("\n")):
        m = re.match(r"^\[(\d+)\]", ln)
        if m and i in pmap:
            out[int(m.group(1))] = pmap[i]
    return out


# ---------------------------------------------------------------- 拒答闸的信号
def build_idf(rows, rows_by_id):
    """语料 IDF —— **与 `retrieval-bench.py` §7 表 D 同一配方**(词集用 doc_terms)。"""
    df, n = {}, len(rows)
    for r in rows:
        for t in set(rb.doc_terms(rows_by_id, r["memory_id"])):
            df[t] = df.get(t, 0) + 1
    return {t: math.log(1.0 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}


def _zsig(xs):
    if len(xs) < 2:
        return 0.0
    mu = sum(xs) / len(xs)
    sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs))
    z = (max(xs) - mu) / sd if sd > 1e-9 else 0.0
    return 1.0 / (1.0 + math.exp(-z))


def confidence(signal, q, items, rows_by_id, idf):
    """这一问的**置信度**(闸的门限信号)。

    ⚠️ 与表 D 对齐的三处,少一处都会让闸**永不触发**:
      ① **排除 L0 常驻占位** —— L0 每条都撞查询词,不排掉的话置信度永远很高
         (2026-09-30 实测:τ 扫到 0.20 数字一个没动,根因就是这条);
      ② 池用 **POOL_K(20)** 条,不是 top-5;
      ③ 词集用 `doc_terms`、查询词元用 `uniq_terms`,与 `idf_cov` 完全一致。
    """
    cand = [it for it in items if str(it.get("layer") or "") != "L0"]
    covs = [float(it.get("hits") or 0.0) for it in cand]
    tots = [float(it.get("total") or 0.0) for it in cand]
    qt = rb.uniq_terms(q)
    tot_idf = sum(idf.get(t, 0.0) for t in qt)
    idfs = []
    for it in cand:
        at = rb.doc_terms(rows_by_id, it["memory_id"])
        idfs.append(sum(idf.get(t, 0.0) for t in qt if t in at) / tot_idf if tot_idf > 0 else 0.0)
    if signal == "raw":
        return max(tots) if tots else 0.0
    if signal == "cov":
        return max(covs) if covs else 0.0
    if signal == "zsig":
        return _zsig(covs)
    if signal == "idf":
        return max(idfs) if idfs else 0.0
    if signal == "zsig_idf":
        return _zsig(idfs)
    return 0.0


def llm_call(prompt, endpoint, key, model, cache, system=SYS_PROMPT, tries=3):
    """一次补全;带磁盘缓存(同 prompt+system 不重复花钱)与 429 退避。"""
    ck = hashlib.sha1(("%s|%s|%s|%s" % (endpoint, model, system, prompt)).encode("utf-8")).hexdigest()
    if ck in cache:
        return cache[ck]
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
        "temperature": 0.0, "max_tokens": 200,
    }).encode("utf-8")
    last = ""
    for i in range(tries):
        try:
            req = urllib.request.Request(
                endpoint, data=body,
                headers={"Content-Type": "application/json; charset=utf-8",
                         "Authorization": "Bearer %s" % key})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = (data["choices"][0]["message"]["content"] or "").strip()
            cache[ck] = out
            return out
        except Exception as exc:                     # 429/超时/连接:退避重试
            last = str(exc)
            time.sleep(2.0 * (i + 1))
    cache[ck] = ""                                    # 明确记成"没答出来",不静默当没有
    return ""


def scored_quiet(q, env, rows, k, now):
    """调生产打分拿**逐条分数**(闸的门限信号要用它),同样吞掉 stdout。"""
    with contextlib.redirect_stdout(io.StringIO()):
        return rb.prod_retrieve.rank_memories([dict(r) for r in rows], q, k, now)


def qterms(text):
    """量台里的 uniq_terms 返回 **list**;这里一律当集合用。"""
    return set(rb.uniq_terms(text))


def count_tokens(text):
    """粗口径:一个汉字 = 1 token,一个西文词/数字串 = 1 token,标点忽略。

    不追求与某个 tokenizer 对齐 —— 它只需要**在变体之间可比**,
    以及把"同预算"这件事变成可核对的数字。
    """
    n = 0
    latin_run = False
    for ch in text:
        if "\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff":
            n += 1
            latin_run = False
        elif ch.isalnum():
            if not latin_run:
                n += 1
                latin_run = True
        else:
            latin_run = False
    return n


def truncate_tokens(text, budget):
    out = []
    n = 0
    latin_run = False
    for ch in text:
        if "\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff":
            if n >= budget:
                break
            n += 1
            latin_run = False
        elif ch.isalnum():
            if not latin_run:
                if n >= budget:
                    break
                n += 1
                latin_run = True
        else:
            latin_run = False
        out.append(ch)
    return "".join(out)


# ---------------------------------------------------------------- 装配
def best_line(seg, q_terms):
    """段内最相关的那一句(证据高亮用)。"""
    best, best_score = "", -1.0
    for s in rb.SEG_RE.split(seg):
        s = s.strip()
        if len(s) < 4:
            continue
        t = qterms(s)
        if not t or not q_terms:
            continue
        score = len(t & q_terms) / float(len(q_terms))
        if score > best_score:
            best, best_score = s, score
    return best


def assemble(variant, segs, q_terms, seed=17):
    """segs: [(memory_id, text), ...] 按分数序。返回 (上下文文本, 行→来源 id 表)。"""
    if not segs:
        return "", []
    items = list(segs)
    tag = "V" + variant.split()[0][1:]
    if tag == "V1" and len(items) >= 2:
        items = [items[0], items[-1]] + items[1:-1]
    elif tag == "V3":
        items = list(reversed(items))
    elif tag == "V4":
        rnd = random.Random(seed)
        items = items[:]
        rnd.shuffle(items)
    lines = []
    prov = []                      # (行号, 来源 memory_id)
    for idx, (mid, txt) in enumerate(items):
        lines.append("[%d] %s" % (idx + 1, txt))
        prov.append((len(lines) - 1, mid))
        if tag == "V2":
            ev = best_line(txt, q_terms)
            if ev:
                lines.append("证据: %s" % ev)
                prov.append((len(lines) - 1, mid))
    return "\n".join(lines), prov


# ---------------------------------------------------------------- 消费者
def consume_extractive(context, prov, query, q_terms):
    """离线消费者:在**被呈现的内容**里挑最相关的一行,并记住它来自哪条记忆。

    它就是"一个只会照着上下文念的读者" —— 廉价、确定性、无网络。
    量的是"喂进去的东西够不够让一个读者答出来",不是"模型会不会推理"。
    """
    lines = [(i, ln) for i, ln in enumerate(context.split("\n")) if len(ln.strip()) >= 4]
    if not lines:
        return "", None
    src = dict(prov)
    best, best_score, best_src = "", -1.0, None
    for i, ln in lines:
        t = qterms(ln)
        if not t or not q_terms:
            continue
        score = len(t & q_terms) / float(len(q_terms))
        if score > best_score:
            best, best_score, best_src = ln.strip(), score, src.get(i)
    if best_score <= 0.0:
        return "", None
    return best, best_src


def consume_first(context, prov, query, q_terms):
    """消费者负控:只会念第一行(证明"消费者"这一环真的在起作用)。"""
    for i, ln in enumerate(context.split("\n")):
        if len(ln.strip()) >= 4:
            return ln.strip(), dict(prov).get(i)
    return "", None


def consume_llm(context, prov, query, q_terms, endpoint, key, model, cache):
    """真模型消费者(重叠判定口径)。"""
    if not context.strip():
        return "", None
    return llm_call(build_prompt(context, query), endpoint, key, model, cache), None


def llm_verdict(ctx, prov, q, accept, rows_by_id, endpoint, key, model, cache, use_cite=True):
    """LLM 消费者的**唯一判定入口**,返回 (答案, 来源 id, 判定)。

    use_cite=True(默认):让模型自标出处 ⇒ **精确的来源判定**(不猜改写型答案);
    否则退回 6-gram 重叠判定(θ=0.35),那只适合"答案照抄片段"的情形。
    """
    if not ctx.strip():
        return "", None, "拒答"
    if not use_cite:
        ans, _ = consume_llm(ctx, prov, q, set(), endpoint, key, model, cache)
        v, src = judge_overlap(ans, accept, rows_by_id)
        if not accept:
            v = "拒答" if v == "拒答" else "误认"
        return ans, src, v
    raw = llm_call(build_cite_prompt(ctx, q), endpoint, key, model, cache, system=SYS_PROMPT_CITE)
    ans, cite = parse_cite(raw)
    if cite is None:
        return ans, None, "拒答"
    src = num2id(ctx, prov).get(cite)
    if src is None:
        return ans, None, "拒答"
    if not accept:
        return ans, src, "误认"          # 闲聊档:取了记忆就是错
    return ans, src, ("命中" if src in accept else "误认")


# ---------------------------------------------------------------- 判定
def shingles(text, n=6):
    t = "".join(ch for ch in text if ch.isalnum() or "\u3400" <= ch <= "\u9fff")
    return {t[i:i + n] for i in range(0, max(0, len(t) - n + 1))} or {t}


def judge_overlap(answer, accept, rows_by_id, theta=0.35):
    """LLM 消费者的判定:答案与哪条记忆的 6-gram 重叠最高。"""
    if not answer or answer.strip() in ("不知道", "不知道。", "无法回答"):
        return "拒答", None
    a = shingles(answer)
    if not a:
        return "拒答", None
    best_id, best_ratio = None, 0.0
    for mid, row in rows_by_id.items():
        d = shingles(rb.doc_text(row))
        if not d:
            continue
        r = len(a & d) / float(len(a))
        if r > best_ratio:
            best_id, best_ratio = mid, r
    if best_ratio < theta:
        return "拒答", None
    return ("命中" if best_id in accept else "误认"), best_id


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--method", default="R0现状")
    ap.add_argument("--also", default="",
                    help="顺带对照的另一路(留空则不比;如 --also R1BM25)")
    ap.add_argument("--k", type=int, default=TOP_K)
    ap.add_argument("--consumer", default="extractive",
                    choices=["extractive", "first", "llm"])
    ap.add_argument("--variants", default=",".join(v[0].split()[0] for v in VARIANTS),
                    help="只跑这些变体标签,逗号分隔(如 V0,V2)")
    ap.add_argument("--budget", type=int, default=0,
                    help=">0 时把所有变体截到同一 token 预算")
    ap.add_argument("--llm-endpoint", default=None,
                    help="留空 = 用本机网关(%s)" % DEFAULT_ENDPOINT)
    ap.add_argument("--llm-key", default=None,
                    help="留空 = 从 ~/.dsh/.credentials.yaml 的 %s 取(只读,不打印)" % DEFAULT_KEY_REF)
    ap.add_argument("--llm-model", default=DEFAULT_MODEL)
    ap.add_argument("--no-cite", action="store_true",
                    help="关掉引用式口径,退回 6-gram 重叠判定(只适合照抄型答案)")
    ap.add_argument("--gate", default="off",
                    choices=["off", "cov", "raw", "idf", "zsig", "zsig_idf"],
                    help="拒答闸的门限信号(off = 不设闸);与 bench §7 表 D 同配方")
    ap.add_argument("--taus", default="0.05,0.10",
                    help="闸的门限扫描(逗号分隔);信号 < τ ⇒ 整池清空")
    ap.add_argument("--cache", default=os.path.join(ROOT, ".scratch", "l4-cache.json"),
                    help="补全缓存:同一 prompt 不重复花钱")
    ap.add_argument("--limit", type=int, default=0, help=">0 只跑前 N 条金标(冒烟用)")
    ap.add_argument("--dump", default=None)
    args = ap.parse_args()

    env = bootstrap(args.db)
    rows, rows_by_id, bm = env["rows"], env["rows_by_id"], env["bm"]
    fts_conn, golden = env["fts_conn"], env["golden"]
    if args.limit > 0:
        golden = golden[:args.limit]
        print("  [!] 冒烟模式:只跑前 %d 条金标" % args.limit)
    positive = [g for g in golden if g["accept"]]
    negative = [g for g in golden if not g["accept"]]
    now = time.time()

    variants = [v for v in VARIANTS
                if v[0].split()[0] in {t.strip() for t in args.variants.split(",") if t.strip()}]
    if not variants:
        variants = list(VARIANTS)
    endpoint, key, cache = args.llm_endpoint, args.llm_key, {}
    if args.consumer == "llm":
        endpoint = endpoint or DEFAULT_ENDPOINT
        key = key or load_gateway_key()
        if not key:
            print("[!] 取不到网关密钥(%s)⇒ 退回 extractive(离线消费者)" % DEFAULT_KEY_REF)
            args.consumer = "extractive"
        elif args.cache and os.path.exists(args.cache):
            try:
                cache = json.load(open(args.cache, encoding="utf-8"))
                print("  补全缓存: 已有 %d 条(%s)" % (len(cache), args.cache))
            except Exception as exc:
                print("  缓存读不出(%s)⇒ 忽略" % exc)

    methods = [args.method] + ([args.also] if args.also else [])
    print("=" * 78)
    print("  呈现层 / 生成端量台(L4)")
    print("=" * 78)
    print("  语料 %d 条;金标 %d = 正 %d + 负控 %d;消费者 = %s;K = %d;变体 = %s"
          % (len(rows), len(golden), len(positive), len(negative), args.consumer, args.k,
             ",".join(v[0].split()[0] for v in variants)))
    if args.consumer == "llm":
        print("  模型 = %s @ %s" % (args.llm_model, endpoint))
    print("  装配变体:")
    for name, desc in variants:
        print("    %-14s %s" % (name, desc))
    print()

    # ---- 逐条:取候选 → 装配 → 消费 → 判定 ----
    res = {}          # (method, variant) -> list of records
    cov_gold = {}     # gi -> 金标 ∩ 候选(k) —— 检索层取到了没有
    conf = {}         # gi -> 这一问的置信度(闸的门限信号)
    official = {}     # (gi, method) -> 该路的**宽名单**(官方 recall_all/ndcg_any 用)
    # 会话键:我们的记忆表**没有 session/turn id** ⇒ 轮 = 单条记忆,会话 = 按天分组
    # (用 occurred_at,缺则 timestamp;两者都是 unix 秒)。这是官方 `turn2session` 的等价物。
    sess_of = {}
    for r in rows:
        t = r.get("occurred_at") or r.get("timestamp") or 0
        sess_of[r["memory_id"]] = int(t // 86400) if t else -1
    idf_tab = build_idf(rows, rows_by_id) if args.gate in ("idf", "zsig_idf") else {}
    pool_k = getattr(rb, "POOL_K", 20)
    for m in methods:
        for vname, _ in variants:
            res[(m, vname)] = []
    for gi, g in enumerate(golden):
        q, accept = g["query"], g["accept"]
        q_terms = qterms(q)
        if args.consumer == "llm":
            print("  [llm %d/%d] %s" % (gi + 1, len(golden), q[:38]), flush=True)
        out, pool0 = rank_quiet(q, env, rows, rows_by_id, bm, fts_conn, now)
        ids0 = list(out.get(methods[0], []))[:args.k]
        cov_gold[gi] = set(accept) & set(ids0)          # 检索层有没有把金标取进 k
        for m in methods:
            official[(gi, m)] = pool0.get(m, [])        # 官方指标用宽名单
        if args.gate != "off":
            conf[gi] = confidence(args.gate, q,
                                  scored_quiet(q, env, rows, pool_k, now),
                                  rows_by_id, idf_tab)
        for m in methods:
            ids = list(out.get(m, []))[:args.k]
            segs = [(mid, rb.doc_text(rows_by_id[mid])) for mid in ids if mid in rows_by_id]
            for vname, _ in variants:
                ctx, prov = assemble(vname, segs, q_terms)
                tokens = count_tokens(ctx)
                if args.budget > 0:
                    ctx = truncate_tokens(ctx, args.budget)
                    prov = [(i, mid) for i, mid in prov
                            if i < len(ctx.split("\n"))]
                    tokens = count_tokens(ctx)
                if args.consumer == "extractive":
                    ans, src = consume_extractive(ctx, prov, q, q_terms)
                    verdict = ("命中" if (src in accept and accept) else
                               "误认" if (src is not None and accept) else
                               "拒答" if accept else "-")
                    if accept and src is None:
                        verdict = "拒答"
                elif args.consumer == "first":
                    ans, src = consume_first(ctx, prov, q, q_terms)
                    verdict = ("命中" if (src in accept and accept) else
                               "误认" if (src is not None and accept) else "拒答")
                else:
                    ans, src, verdict = llm_verdict(
                        ctx, prov, q, accept, rows_by_id,
                        endpoint, key, args.llm_model, cache, use_cite=not args.no_cite)
                res[(m, vname)].append(dict(tier=g["tier"], accept=accept, verdict=verdict,
                                            src=src, tokens=tokens, ans=ans[:80], gi=gi))

    # ---- 报告 ----
    def summarize(records):
        hit = sum(1 for r in records if r["verdict"] == "命中" and r["accept"])
        wrong = sum(1 for r in records if r["verdict"] == "误认" and r["accept"])
        abst = sum(1 for r in records if r["verdict"] == "拒答" and r["accept"])
        wrong_neg = sum(1 for r in records if r["verdict"] == "误认" and not r["accept"])
        neg_abst = sum(1 for r in records if r["verdict"] == "拒答" and not r["accept"])
        med = sorted(r["tokens"] for r in records)[len(records) // 2] if records else 0
        # 判定质量:答案非空、又没明说「不知道」,却被判成拒答 ⇒ 可能是 6-gram 判定漏了(改写型答案)
        jmiss = sum(1 for r in records if r["accept"] and r["verdict"] == "拒答"
                    and len(r["ans"].strip()) > 2 and "不知道" not in r["ans"])
        return hit, wrong, abst, wrong_neg, neg_abst, med, jmiss

    v0 = variants[0][0]
    vhl = next((v[0] for v in variants if v[0].startswith("V2")), v0)
    v4 = next((v[0] for v in variants if v[0].startswith("V4")), None)
    print("-" * 78)
    print("  表 1 — 逐变体(消费者 = %s%s)"
          % (args.consumer, ",预算 %d" % args.budget if args.budget else ""))
    print("  %-14s %-8s %6s %6s %6s %8s %6s %8s %6s" %
          ("变体", "方法", "命中", "误认", "答不出", "命中率", "负控误认", "上下文token中位", "疑似判漏"))
    for m in methods:
        for vname, _ in variants:
            rec = res[(m, vname)]
            hit, wrong, abst, wn, na, med, jmiss = summarize(rec)
            print("  %-14s %-8s %6d %6d %6d %7.1f%% %6d %8d %6d"
                  % (vname, m, hit, wrong, abst, 100.0 * hit / max(1, len(positive)), wn, med, jmiss))
        print()
    print("  ⚠️ 分母固定为**金标正样本条数**(%d);负控档 %d 条另列。" % (len(positive), len(negative)))
    print()

    # ---- 同预算对照 ----
    base = res[(methods[0], v0)]
    budget = args.budget or (sorted(r["tokens"] for r in base)[len(base) // 2] if base else 0)
    print("-" * 78)
    print("  表 2 — **同 token 预算**对照(全部截到 %d tokens;CPP 自认的最大方法论缺口)" % budget)
    print("  %-14s %6s %6s %6s %8s" % ("变体", "命中", "误认", "答不出", "命中率"))
    for vname, _ in variants:
        # 为保证不是估算,对每条重跑一次"截到同预算"的装配与消费
        redo = []
        for g in positive:
            q, accept = g["query"], g["accept"]
            q_terms = qterms(q)
            out, _pool2 = rank_quiet(q, env, rows, rows_by_id, bm, fts_conn, now)
            ids = list(out.get(methods[0], []))[:args.k]
            segs = [(mid, rb.doc_text(rows_by_id[mid])) for mid in ids if mid in rows_by_id]
            ctx, prov = assemble(vname, segs, q_terms)
            ctx = truncate_tokens(ctx, budget)
            keep = len(ctx.split("\n"))
            prov = [(i, mid) for i, mid in prov if i < keep]
            if args.consumer == "first":
                ans, src = consume_first(ctx, prov, q, q_terms)
                v = "命中" if src in accept else ("误认" if src is not None else "拒答")
            elif args.consumer == "llm":
                ans, _src, v = llm_verdict(ctx, prov, q, accept, rows_by_id,
                                           endpoint, key, args.llm_model, cache,
                                           use_cite=not args.no_cite)
            else:
                ans, src = consume_extractive(ctx, prov, q, q_terms)
                v = "命中" if src in accept else ("误认" if src is not None else "拒答")
            redo.append(v)
        hit = sum(1 for v in redo if v == "命中")
        wrong = sum(1 for v in redo if v == "误认")
        abst = sum(1 for v in redo if v == "拒答")
        print("  %-14s %6d %6d %6d %7.1f%%"
              % (vname, hit, wrong, abst, 100.0 * hit / max(1, len(positive))))
    print()

    # ---- 三个负控 ----
    print("-" * 78)
    print("  负控(必须过;不过 ⇒ 这一跑的数不可信)")
    n1 = []
    for g in positive:
        q_terms = qterms(g["query"])
        ans, src = consume_extractive("", [], g["query"], q_terms)
        n1.append(1 if src in g["accept"] else 0)
    print("  N1 空上下文 ⇒ 命中 %d/%d ⇒ %s"
          % (sum(n1), len(positive), "过 ✓" if sum(n1) == 0 else "**不过:有假命中 ✗**"))
    if v4:
        rows_a = [(r["verdict"], r["src"], r["tokens"]) for r in res[(methods[0], v0)]]
        rows_b = [(r["verdict"], r["src"], r["tokens"]) for r in res[(methods[0], v4)]]
        same = rows_a == rows_b
        dh = abs(sum(1 for r in res[(methods[0], v0)] if r["verdict"] == "命中")
                 - sum(1 for r in res[(methods[0], v4)] if r["verdict"] == "命中"))
        print("  N2 乱序 vs 现状顺序 ⇒ 逐字%s,命中差 %d 条 ⇒ %s"
              % ("相同" if same else "不同", dh,
                 "过 ✓" if (dh <= 1 or args.consumer == "llm") else "**不过 ✗:装配/判定有 bug**"))
        if args.consumer != "llm":
            print("     标定事实:离线读者的位置敏感性**只来自「并列打分取先者」**(差 %d 条那种量级),"
                  "不是模型的 U 型注意力 ⇒ **位置效应它测不了,只能由 LLM 消费者测**。" % dh)
    else:
        print("  N2 跳过:本跑没跑 V4 乱序")
    print("  N3 消费者对照:本跑消费者 = %s ⇒ 现状顺序命中 %d/%d、高亮命中 %d/%d"
          % (args.consumer,
             sum(1 for r in res[(methods[0], v0)] if r["verdict"] == "命中"),
             len(positive),
             sum(1 for r in res[(methods[0], vhl)] if r["verdict"] == "命中"),
             len(positive)))
    print("     ⇒ 换一个消费者(`--consumer first` / `--consumer llm`)再跑一遍;"
          "**两组数字若相同 ⇒ 消费者这一环没起作用 ✗**")
    print()

    # ---- 逐档 ----
    print("-" * 78)
    print("  表 3 — 逐档(变体 = 现状顺序 / 高亮,方法 = %s)" % methods[0])
    tiers = []
    for g in positive:
        if g["tier"] not in tiers:
            tiers.append(g["tier"])
    print("  %-14s %-14s %6s %6s" % ("档", "变体", "命中", "条数"))
    for t in tiers:
        for vname in (v0, vhl):
            recs = [r for r in res[(methods[0], vname)] if r["tier"] == t and r["accept"]]
            h = sum(1 for r in recs if r["verdict"] == "命中")
            print("  %-14s %-14s %6d %6d" % (t, vname, h, len(recs)))
    print()

    # ---- 表 4:三分归因(检索层 / 呈现层 / 利用层)----
    print("-" * 78)
    print("  表 4 — 三分归因(变体 = 现状顺序 / 高亮;这是生成端存在的理由)")
    print("  %-14s %8s %10s %10s %8s %6s" %
          ("变体", "检索没取到", "取到但答不出", "引到别的记忆", "答对", "条数"))
    for vname in (v0, vhl):
        recs = res[(methods[0], vname)]
        no_cov = gotbut = wrongmem = hit = 0
        for r in recs:
            if not r["accept"]:
                continue
            got = bool(cov_gold.get(r.get("gi")))
            if not got:
                no_cov += 1
            elif r["verdict"] == "命中":
                hit += 1
            elif r["verdict"] == "误认":
                wrongmem += 1
            else:
                gotbut += 1
        tot = len([1 for r in recs if r["accept"]])
        print("  %-14s %8d %10d %10d %8d %6d" % (vname, no_cov, gotbut, wrongmem, hit, tot))
    print("  ⇒ 「检索没取到」= 该修检索/写入侧;「取到但答不出」「引到别的记忆」= 该修呈现/利用侧。")
    print()

    # ---- 表 5:拒答闸端到端 ----
    if args.gate != "off":
        taus = [float(t) for t in args.taus.split(",") if t.strip()]
        print("-" * 78)
        print("  表 5 — 拒答闸**端到端**(信号 = %s;变体 = 现状顺序;消费者 = %s)"
              % (args.gate, args.consumer))
        print("  %-10s %8s %10s %10s %10s %8s" %
              ("τ", "正:命中", "正:被闸掉", "正:答不出", "负:拒答", "负:误取"))
        scen = [("0 无闸", None)] + [("%.2f" % t, t) for t in taus]
        for label, tau in scen:
            hp = gp = apn = nq = nw = 0
            for gi, g in enumerate(golden):
                q, accept = g["query"], g["accept"]
                qt = qterms(q)
                out, _pool3 = rank_quiet(q, env, rows, rows_by_id, bm, fts_conn, now)
                ids = list(out.get(methods[0], []))[:args.k]
                segs = [(mid, rb.doc_text(rows_by_id[mid])) for mid in ids if mid in rows_by_id]
                ctx, prov = assemble(v0, segs, qt)
                gated = tau is not None and conf.get(gi, 0.0) < tau
                if gated:
                    ctx, prov = "", []
                if args.consumer == "llm":
                    ans, src, v = llm_verdict(ctx, prov, q, accept, rows_by_id,
                                              endpoint, key, args.llm_model, cache,
                                              use_cite=not args.no_cite)
                elif args.consumer == "first":
                    ans, src = consume_first(ctx, prov, q, qt)
                    v = "命中" if src in accept else ("误认" if src is not None else "拒答")
                else:
                    ans, src = consume_extractive(ctx, prov, q, qt)
                    v = "命中" if src in accept else ("误认" if src is not None else "拒答")
                if accept:
                    if v == "命中":
                        hp += 1
                    elif gated:
                        gp += 1
                    else:
                        apn += 1
                else:
                    if v == "拒答":
                        nq += 1
                    else:
                        nw += 1
            print("  %-10s %8d %10d %10d %10d %8d" % (label, hp, gp, apn, nq, nw))
        print("  ⇒ 要的是:**负:拒答 ↑、负:误取 ↓**,同时 **正:命中 不退**;"
              "「正:被闸掉」就是**误杀**。")
        print()

    # ---------------------------------------------------------------- 负控自检(ABS 口径)
    # LongMemEval 的拒答档定义:**问的是交互史里从未提及的信息**(可验证),不是"闲聊"。
    # 所以负控题必须同时满足:(1) 答案空集;(2) **库里确实没有任何记忆谈这个主题**。
    # (1) 是构造保证;(2) 这里用 IDF 加权覆盖率做**机械筛查** —— 超线就报"需人工核",
    # 不许静默当过。⚠️ 这一条是"标签体检",不是"系统失败"。
    idf_all = idf_tab if (args.gate in ("idf", "zsig_idf") and idf_tab) else build_idf(rows, rows_by_id)
    negs = [(gi, g) for gi, g in enumerate(golden) if not g["accept"]]
    if negs:
        print("-" * 78)
        print("  表 6 — 负控自检(ABS 口径:答案空集 且 主题在库缺席)")
        print("  %-4s %-30s %9s %10s %s" % ("gi", "查询", "conf_idf", "池内最高", "核查结论"))
        viol = []
        pos_min = None
        for gi, g in enumerate(golden):
            if g["accept"]:
                c = confidence("idf", g["query"], scored_quiet(g["query"], env, rows, pool_k, now),
                               rows_by_id, idf_all)
                pos_min = c if pos_min is None else min(pos_min, c)
        for gi, g in negs:
            items = scored_quiet(g["query"], env, rows, pool_k, now)
            c = confidence("idf", g["query"], items, rows_by_id, idf_all)
            cand = [it for it in items if str(it.get("layer") or "") != "L0"]
            top = cand[0] if cand else None
            best = "%d/%d" % (top.get("hits") or 0, top.get("total") or 0) if top else "-"
            bad = c >= 0.35
            if bad:
                viol.append(gi)
            print("  %-4d %-30s %9.3f %10s %s"
                  % (gi, g["query"][:30], c, best,
                     "⚠️ 疑似不合格(库里可能真有相关记忆)" if bad else "合格"))
        print("  ⇒ 正样本 conf_idf 最低 = %s;⚠️ 条目 = %s"
              % (("%.3f" % pos_min) if pos_min is not None else "-",
                 ("gi " + ", ".join(str(x) for x in viol)) if viol else "无"))
        print("  ⚠️ 命中这条线时 **先怀疑标签**,不是先调系统(官方做法:重做/清洗数据)。")
        print()

    # ---------------------------------------------------------------- 表 7 — 官方检索指标
    if official:
        print("-" * 78)
        print("  表 7 — 官方检索指标(LongMemEval 口径;**recall_any = 我们的对应量**;会话级=按天去重)")
        print("  %-10s %4s %9s %9s %10s %9s %9s %10s" %
              ("方法", "k", "turn_any", "turn_all", "turn_ndcg", "sess_any", "sess_all", "sess_ndcg"))
        for m in methods:
            for k in (5, 10):
                agg = {}
                for gi, g in enumerate(golden):
                    if not g["accept"]:
                        continue          # 官方检索指标**排除 _abs**
                    o = official_retrieval_metrics(official.get((gi, m), []), set(g["accept"]),
                                                   sess_of, k)
                    for kk, vv in o.items():
                        agg.setdefault(kk, []).append(vv)
                n = max(1, len(agg.get("turn_recall_all", [])))
                mu = lambda key: sum(agg.get(key, [])) / n
                print("  %-10s %4d %9.3f %9.3f %10.3f %9.3f %9.3f %10.3f"
                      % (m.split()[0], k, mu("turn_recall_any"), mu("turn_recall_all"),
                         mu("turn_ndcg_any"), mu("sess_recall_any"), mu("sess_recall_all"),
                         mu("sess_ndcg_any")))
        print("  ⚠️ 口径差异:官方单位是**轮/会话**,我们的表 = 单条记忆,**会话按天分组**(库里无会话 id)")
        print("  ⚠️ **语义差异(重要)**:官方的 `answer_session_ids` 是**必备证据**(缺一条就算漏),")
        print("     我们的 `accept` 是**并列可选**(捞到任意一条就够)⇒ 对应官方的是 **recall_any**;")
        print("     `recall_all` 在这里只当「捞全程度」参考,**不是**官方那个 recall_all。")
        print("     ⇒ 与论文表格的数字**不可直接比**;同批数据内部可比。")
        print()

    if args.consumer == "llm":
        print("  这一跑**量到了**:真模型从被呈现的内容里能不能答对(含位置变体 V1/V3)。")
        print("  这一跑**没量到**:多轮推理/长链利用(这里是单轮问答口径)。")
        print("  判定口径:%s" % ("模型自标出处 ⇒ **精确来源判定**(命中 = 引用到金标记忆)"
                                if not args.no_cite
                                else "6-gram 重叠 θ=0.35(**只适合照抄型答案**,会低估改写型)"))
    else:
        print("  这一跑**量到了**:被呈现的内容(哪些段、多少 token、有没有高亮)够不够让一个离线读者答出来。")
        print("  这一跑**没量到**:位置效应(需 LLM 消费者)、推理/利用层(取到了也能用错)。")
    if env["tmpdir"]:
        shutil.rmtree(env["tmpdir"], ignore_errors=True)
    if args.consumer == "llm" and args.cache:
        with open(args.cache, "w", encoding="utf-8") as fh:
            json.dump(cache, fh, ensure_ascii=False)
        print("  补全缓存已写出: %s(%d 条)" % (args.cache, len(cache)))
    if args.dump:
        with open(args.dump, "w", encoding="utf-8") as fh:
            json.dump({"|".join(k): [{**r, "accept": sorted(r["accept"] or [])} for r in v]
                       for k, v in res.items()}, fh, ensure_ascii=False, indent=1)
        print("  已写出: %s" % args.dump)


if __name__ == "__main__":
    main()
