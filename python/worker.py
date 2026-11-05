#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-echo Python 引擎侧车 —— worker.py
============================================================
M2-a 范围:echo_wire_v1 协议骨架与进程生命周期。

分工铁律(PLAN §5):DSH 对接与 LLM 调用留在 JS 壳(subagents 官方通道,
本进程不碰任何 API/密钥/网络);本进程是引擎,纯标准库(≥3.9,零 pip
零 venv),单一写者拥有 ~/.dsh/echo/echo.db。

协议纪律(echo_wire_v1):
  - 传输:stdio 上的 JSON Lines —— 一行一个 JSON 对象,UTF-8;
  - stdout 只出协议帧(诊断一律走 stderr,绝不混进 stdout);
  - stderr 预算 64 行(auto-memory 契约先例:防诊断刷屏撑爆管道);
  - reqId 严格配对:请求带什么 reqId,应答原样带回;
  - 纯被动:不主动推送任何帧,问一句答一句;
  - hello 先行:未握手前业务帧一律拒收;协议版本不认识 → 致命错误
    快速失败(免得两边各说各话空转);
  - 已知协议内的未知帧 type → 非致命错误帧(前向兼容:新壳配老
    worker,一帧不认识不至于崩全程)。

取消(0.45.0 新增,echo_wire_v1 向后兼容扩展):
  - 壳 → 引擎:`{"type": "cancel", "targetReqId": <n>}`(**带外**帧,
    自己不带 reqId,引擎不为它单独回帧);
  - 引擎 → 壳:`{"reqId": <targetReqId>, "type": "cancelled"}`,与业务
    应答同一个 reqId 通道,壳据此把挂着的 promise 落地;
  - 取消是**正常控制流**:不致命、不计失败、不击杀进程 —— 与「请求
    超时 = 引擎不可信,击杀并记账」是两回事,别混;
  - 老壳不认识 cancel 帧 ⇒ 不发就是了;老 worker 收到未知 type ⇒
    回非致命错误帧(既有前向兼容规则已覆盖,不需要新分支)。

为什么 stdin 要一个独立读线程:
  主循环跑在 rank_memories / 图谱 BFS 里时**根本没在读 stdin**,壳发来的
  cancel 要等当前请求整个跑完才会被看见 —— 那等于没有取消。读线程只做
  两件事:把 cancel 立刻交给 engine.cancel 置位,其余帧原样入队给业务
  线程。它**不碰 stdout**(协议级错误也塞回队列由业务线程回帧),所以
  send() 仍然只有一个写者,不需要加锁。

M2-a 的引擎帧(retrieve/extract_prompt/extract_commit/stats/longing_check)
返回类型正确的空壳并带 stub:true —— b1-b6 逐个填肉。壳侧(M2-c/d)
凭 stub 标记即可区分「引擎还没这功能」和「引擎坏了」。已填肉的帧
(M2-b1 起的 threads_*)不再带 stub 标记 —— 真实现即无标记。
"""

import json
import queue
import re
import sqlite3
import sys
import threading
import time
from pathlib import Path

from engine import agenda
from engine import cancel
from engine import dmae
from engine import embed
from engine import episodic
from engine import graph
from engine import graph_gate
from engine import graph_mine
from engine import judge
from engine import l0_tier
from engine import longing
from engine import reflection
from engine import relations
from engine import retrieve
from engine import threads
from engine import timeintent
from engine import timeutil

PROTOCOL = "echo_wire_v1"
HERE = Path(__file__).resolve().parent

# 版本号唯一事实源是 package.json:JS/Python 两侧同源,不各自维护一套
# (装机后相对布局不变,../package.json 依然成立)。
try:
    _PKG = json.loads((HERE.parent / "package.json").read_text(encoding="utf-8"))
    VERSION = str(_PKG.get("version", "0"))
except Exception:  # 版本读不到不致命:报 0 让对端自己判断新旧
    VERSION = "0"

MAX_LINE = 1024 * 1024  # 1MiB:extract_commit 会带对话文本,够用;防病态帧撑爆内存
_DIAG_BUDGET = 64
_diag_used = 0


def diag(message):
    """stderr 诊断,64 行预算:超预算静默丢弃(auto-memory worker 先例)。"""
    global _diag_used
    if _diag_used >= _DIAG_BUDGET:
        return
    _diag_used += 1
    try:
        print("[echo-worker] " + message, file=sys.stderr)
        sys.stderr.flush()
    except Exception:
        pass


def send(frame):
    """stdout 只出协议帧:一行 JSON,写完即 flush(对端逐行读)。"""
    sys.stdout.write(json.dumps(frame, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def error_frame(req_id, message, fatal=False):
    return {"reqId": req_id, "type": "error", "error": message, "fatal": fatal}


def _db_conn(state):
    """业务帧取库连接。

    must_exist:库文件由 JS 壳负责创建(store.js openStore 建库建表),
    worker 永不建库 —— 文件中途消失是异常,报错而不是悄悄重建一个
    空库让记忆「静默失忆」。hello 验库没过同样拒绝。
    """
    if not state.get("db_ok") or not state.get("db_path"):
        raise RuntimeError("db unavailable (hello reported not ok)")
    return threads.connect(state["db_path"], must_exist=True)


def verify_db(db_path):
    """hello 验库:文件存在、能开、能查即 ok。

    只验不建:DDL/引擎读写是 b 步的事,这里绝不创建任何东西 ——
    单一写者纪律从第一行代码开始(库该由谁建,是 b 步的显式决策)。
    裸 connect 对不存在的路径会静默建空库 —— 必须先验存在,否则
    「打错路径」会变成「静默失忆到一个新空库」(M2-c 客户端测试
    当场抓获)。
    """
    if not db_path:
        return {"ok": False, "path": "", "error": "dbPath required"}
    if db_path != ":memory:" and not Path(db_path).exists():
        return {"ok": False, "path": db_path, "error": "db file not found"}
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
            ).fetchone()
            return {"ok": True, "path": db_path, "tables": int(row[0])}
        finally:
            conn.close()
    except Exception as exc:  # 验库失败是应答内容,不是崩溃
        return {"ok": False, "path": db_path, "error": str(exc)}


def start_embed_warmup(state, db_path):
    """Step B:向量臂预热。**默认关的门控 + 后台线程 + 永不抛。**

    为什么是**后台线程**而不是握手前同步跑(与最初设想的写法不同):

      · 同步跑在 `send(ready)` **之前** ⇒ 预热上限 30s 可能超过壳的握手超时
        `handshakeTimeoutMs = 8000` ⇒ **壳会判握手失败并击杀 worker**。
        那正是"向量臂把 worker 搞死"—— 本步明确要避免的事。
      · 同步跑在 `send(ready)` **之后** ⇒ 主循环被占住,期间到达的帧全排队;
        若排队的是 `retrieve`,壳侧 `RETRIEVE_TIMEOUT_MS = 4000` 到点会
        `_kill` + 记失败,3 连败熔断。同样是"预热把 worker 搞死"。

    ⇒ 后台 daemon 线程:握手立即返回、主循环照常收帧,预热跑在一边。
    预热完成/失败都只写 `state["embed"]` 与状态文件,不碰任何帧。

    门控:环境变量 `ECHO_EMBED_WARMUP` 或 config.json **顶层**的 `embedWarmup`,
    **默认关** ⇒ 关着时连 import 都不做,与今天逐位一致。
    """
    src = embed.warmup_source()
    if not src["on"]:
        state["embed"] = {"warmed": False, "reason": "预热开关关着(默认)", "ms": None,
                          "source": src}
        embed.publish(db_path)          # 把"关着"也上报,状态面才不会一片空白
        diag("embed warmup: 关着(%s)" % src["detail"])
        return
    state["embed"] = {"warmed": False, "reason": "预热中", "ms": None, "source": src}

    def _run():
        try:
            st = embed.warmup(db_path)          # 契约:永不抛
            state["embed"] = {"warmed": bool(st["ok"]), "reason": st["reason"],
                              "ms": st["ms"], "source": src}
            diag("embed warmup: ok=%s ms=%s %s" % (st["ok"], st["ms"], st["reason"]))
        except Exception as exc:                # 兜底:这一层也不许把线程掀翻
            state["embed"] = {"warmed": False, "reason": "预热线程异常: %s" % str(exc)[:160],
                              "ms": None, "source": src}
            diag("embed warmup thread crashed: %s" % str(exc)[:160])
        embed.publish(db_path)                  # 完成后上报(写不了也不影响任何事)

    threading.Thread(target=_run, name="echo-embed-warmup", daemon=True).start()


def handle(frame, state):
    """帧分发。返回 'fatal'(退出码 1)/ 'bye'(退出码 0)/ None(继续)。"""
    ftype = frame.get("type")
    req_id = frame.get("reqId")

    # P3-a「通路先行」:数据文件经帧下发(关系表 / 词表 / 状态初值)。
    # 空 / 缺 / 坏形状 ⇒ 各模块回落代码里的内置表 = **迁移前的行为**(等价性要求);
    # 任何一个模块的脏数据都不许影响这一帧(各自 never-throw)。
    _data = graph_gate.data_from_frame(frame)
    for _mod in (relations, timeintent, judge, graph, retrieve.lexical):  # lexical 经 retrieve 转手(worker 顶部无 lexical 行,本批只许改这一行)
        try:
            _mod.configure_from_data(_data)
        except Exception:
            pass

    if ftype == "hello":
        protocol = str(frame.get("protocol") or "")
        if protocol != PROTOCOL:
            # 快速失败:协议都不认识,后面每一帧都是鸡同鸭讲
            send(error_frame(
                req_id,
                "protocol mismatch: worker speaks " + PROTOCOL,
                fatal=True,
            ))
            return "fatal"
        db_path = str(frame.get("dbPath") or "")
        state["db"] = verify_db(db_path)
        state["db_ok"] = bool(state["db"]["ok"])
        state["db_path"] = db_path
        state["ready"] = True
        # ---- Step B:向量臂预热(默认关;后台线程,永不阻塞握手) ----
        start_embed_warmup(state, db_path)
        send({
            "reqId": req_id,
            "type": "ready",
            "engine": "python",
            "version": VERSION,
            "protocol": PROTOCOL,
            "db": state["db"],
            "embed": state.get("embed"),
        })
        return None

    if not state.get("ready"):
        # hello 先行:没握手就问业务,拒收但不断线 —— 对端收到明确错误
        # 比收到 EOF 强(EOF 会被误判成 worker 崩了)
        send(error_frame(req_id, "hello required before " + str(ftype)))
        return None

    if ftype == "ping":
        send({"reqId": req_id, "type": "pong"})
        return None

    if ftype == "embed_probe":
        # Step B:让能发帧的调用方(脚本 / 测试 / 将来的面板路由)主动问
        # "向量臂活着吗"。**纯只读**:不加载、不预热、不改任何状态 ——
        # 它读的是 hello 时那一次预热的现状(含"预热中"这个中间态)。
        #
        # 为什么要有它:状态文件(embed-state.json)是给**壳侧状态面**读的,
        # 但那是"最后一次已知状态";这一帧给的是**此刻**的读数,而且能顺带
        # 报出开关来源(env / config / 默认关)—— 两路 OR 时最怕"面板显示关、
        # 引擎却在跑",报来源就不会读出两个答案。
        cur = state.get("embed") or {"warmed": False, "reason": "尚未预热", "ms": None}
        send({
            "reqId": req_id,
            "type": "embed_probe_result",
            "embed": cur,
            "source": embed.warmup_source(),
            "available": embed.available(state.get("db_path")),
            "model_dir": embed.model_dir(state.get("db_path")),
            "state_file": embed.state_path(state.get("db_path")),
            "rss_mb": embed.rss_mb(),
        })
        return None

    if ftype == "retrieve":
        # M2-b3 真实引擎:六档锚定 + DMAE 加权 + L0 豁免与强制占位
        # min(8, top_k−2) + 召回即强化(含占位 L0 —— 与图侧 pinned 的
        # 豁免是刻意的不对称)。text 为渲染好的注入文本(渲染单一事实源
        # 在引擎侧);state/profile 留给后续 b 步(情绪/画像)。
        user_id = str(frame.get("userId") or "")
        query = str(frame.get("query") or "")
        if not user_id or not query:
            send(error_frame(req_id, "userId and query required"))
            return None
        top_k = int(frame.get("topK") or 6)
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        # 2026-09-30:生产注入路径显式打开那三项(实测见 `docs/RETRIEVAL_OPT_2026-09-30.md`)。
        # `opts` 是壳递来的覆盖;缺什么就用引擎里那份生产默认(`retrieve.PROD_*`)
        # ⇒ "生产开、量台关"这条纪律落在**一处**,不在两处各写一份默认。
        opts = frame.get("opts") if isinstance(frame.get("opts"), dict) else {}
        core_block = bool(opts.get("coreBlock", retrieve.PROD_CORE_BLOCK))
        fusion = opts.get("fusion", retrieve.PROD_FUSION)
        time_arm = bool(opts.get("timeArm", retrieve.PROD_TIME_ARM))
        # 2026-09-30:查询扩展(壳侧宿主模型现生成,见 lib/query-expand.js)。
        # 帧里没有扩展词 ⇒ extra_terms=None ⇒ 这一位一个字不走(老行为)。
        _ext = opts.get("expandTerms")
        extra_terms = [str(t) for t in _ext] if isinstance(_ext, list) else None
        expand_score = bool(opts.get("expandScore", retrieve.PROD_EXPAND_SCORE))
        # 2026-09-30:写入侧"说法键"进打分正文(数据门控:没键的行一个字面都不加)
        aug_keys = bool(opts.get("augKeys", retrieve.PROD_AUG_KEYS))
        # (v0.29.0:渠道过滤随群聊拒收一起退役 —— 记忆不再分渠道。)
        try:
            conn = _db_conn(state)
            try:
                items, reinforced = retrieve.retrieve(
                    conn, user_id, query, top_k, now=now,
                    core_block=core_block, fusion=fusion, time_arm=time_arm,
                    extra_terms=extra_terms, expand_score=expand_score,
                    aug_keys=aug_keys)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "retrieve failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "retrieve_result",
              "items": items, "text": retrieve.render_episodic(items),
              "reinforced": reinforced, "now": now,
              "state": None, "profile": None})
        return None

    if ftype == "extract_prompt":
        # M2-b4 真实供给:合并版系统提示词 + outputSchema(单一事实源,
        # 壳只跑 LLM)。prevVector 由壳拼进用户侧提示词,不进系统提示词。
        # v0.16.0 M2:knownEntities 由壳给(它读得到库),引擎只负责拼进
        # 提示词 —— 「复用现有实体名」这条纪律比事后合并图谱便宜且保真。
        known = frame.get("knownEntities")
        send({"reqId": req_id, "type": "extract_prompt_result",
              "prompt": judge.build_extract_prompt(
                  known_entities=known if isinstance(known, list) else None),
              "schema": judge.build_extract_schema()})
        return None

    if ftype == "extract_commit":
        # M2-b4 写入链:三层校验(纯代码)→ 候选落情景库(I 合成/
        # 槽位取代/绝对时间)→ 无候选降级 emotion_score 门卫 → 三元组
        # 落图 → 悬置话题先消解再登记 → name/画像交壳。
        # structured = LLM 合并输出(原始未规整);text = 用户本轮原话。
        owner = str(frame.get("userId") or "")
        structured = frame.get("structured")
        text = str(frame.get("text") or "")
        if not owner or not isinstance(structured, dict):
            send(error_frame(req_id, "userId and structured required"))
            return None
        session_id = str(frame.get("sessionId") or "")
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        # v0.16.0 M3:近重复闸阈值由壳给(面板可调);缺省用引擎默认。
        dedupe_opts = frame.get("dedupe")
        try:
            conn = _db_conn(state)
            try:
                ack = judge.commit(conn, owner, structured, text,
                                   session_id=session_id, now=now,
                                   dedupe=dedupe_opts if isinstance(dedupe_opts, dict) else None,
                                   names=frame.get("names"))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "extract_commit failed: " + str(exc)))
            return None
        ack["reqId"] = req_id
        ack["type"] = "extract_ack"
        send(ack)
        return None

    if ftype == "stats":
        # b 步填肉:对齐 JS 基线 memoryStats 的形状(差分测试的靶子)
        send({"reqId": req_id, "type": "stats_result",
              "stats": None, "stub": True})
        return None

    # ---- M2-b6 她的议程簿(真实引擎)----

    if ftype == "agenda_pick":
        # 效用排序取 top-1(关怀组稿用)。her_agenda 是单主人全局表,
        # 与 AstrBot 同构 —— 不按 userId 过滤。vector 供想念匹配,
        # interests 是 persona 配置(壳侧持有,引擎不读配置)。
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        try:
            conn = _db_conn(state)
            try:
                item_id, content = agenda.pick(
                    conn, vec=frame.get("vector"), now=now,
                    interests=frame.get("interests"))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "agenda_pick failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "agenda_pick_result",
              "itemId": item_id, "content": content})
        return None

    if ftype == "agenda_mark":
        # 用过降权(48h 冷却)。调用方纪律:发送成功才调。
        item_id = frame.get("itemId")
        if not item_id:
            send(error_frame(req_id, "itemId required"))
            return None
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        try:
            conn = _db_conn(state)
            try:
                ok = agenda.mark_used(conn, item_id, now=now)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "agenda_mark failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "agenda_mark_result", "ok": ok})
        return None

    # ---- M3-b 记忆工具族(用户直教:remember / forget / search)----

    if ftype == "memory_add":
        # <称呼>亲口教的事:certainty=explicit / attribution=user_explicit
        # —— Judge 信任权重的最高档。「谁为这句话负责」的答案在这里
        # 最干净:用户自己。关键词规则派生(无 LLM 可问);slot 可选
        # (同槽位取代照常发生 —— 教第二遍是换代不是叠加)。
        user_id = str(frame.get("userId") or "")
        text = str(frame.get("text") or "").strip()
        if not user_id or not text:
            send(error_frame(req_id, "userId and text required"))
            return None
        slot = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff]+", "_",
                      str(frame.get("slot") or "").strip())[:64].strip("_")
        layer = "L0" if str(frame.get("layer") or "").strip().upper() == "L0" else "L2"
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        kws = episodic.derive_keywords(text)
        try:
            conn = _db_conn(state)
            try:
                # agent_state 是全局单行(session_id 键,DSH 单主人);
                # 取不到就中性 3 —— 直教的 I 不该因读不到心情而拒写
                row = conn.execute(
                    "SELECT mood_intensity FROM agent_state"
                    " ORDER BY updated_at DESC LIMIT 1").fetchone()
                mood = float(row[0]) if row and row[0] else 3.0
                i_val = dmae.compute_intrinsic_value(
                    layer=layer, certainty="explicit",
                    attribution="user_explicit", stability="stable",
                    emotion=mood, quote_count=len(kws))
                mid = episodic.insert_memory(
                    conn, user_id,
                    json.dumps(kws, ensure_ascii=False),
                    text[:120], 3,
                    source="user_taught", source_label="echo_remember",
                    intrinsic_value=i_val,
                    memory_key=slot, layer=layer, now=now)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "memory_add failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "memory_add_result",
              "memoryId": mid, "keywords": kws,
              "I": round(i_val, 1), "layer": layer})
        return None

    if ftype == "memory_forget":
        # 遗忘:只读匹配(reinforce=False —— 查到要忘的事绝不能强化
        # 它),hits>0 即目标;>10 拒绝(防「忘掉一切」式误伤,要求说
        # 具体点);命中即 is_active=0 —— superseded_by 不指:不是被
        # 取代,是被主人亲手抹掉。
        user_id = str(frame.get("userId") or "")
        query = str(frame.get("query") or "").strip()
        if not user_id or not query:
            send(error_frame(req_id, "userId and query required"))
            return None
        try:
            conn = _db_conn(state)
            try:
                # dedupe=False(RT4):**枚举**用途 —— 「>10 拒绝」是数匹配条数
                # 的,折叠近重复会让 11 条近似记忆变成 1 条,保护直接失效。
                items, _ = retrieve.retrieve(
                    conn, user_id, query, 20, reinforce=False, dedupe=False)
                targets = [it for it in items
                           if float(it.get("hits") or 0) > 0]
                if len(targets) > 10:
                    send({"reqId": req_id, "type": "memory_forget_result",
                          "ok": False, "reason": "too_broad",
                          "matched": len(targets)})
                    return None
                forgotten = []
                for it in targets:
                    conn.execute(
                        "UPDATE episodic_memory SET is_active = 0"
                        " WHERE memory_id = ?", (it["memory_id"],))
                    forgotten.append({
                        "memoryId": it["memory_id"],
                        "summary": str(it.get("summary") or "")[:80],
                        "layer": str(it.get("layer") or "")})
                conn.commit()
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "memory_forget failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "memory_forget_result",
              "ok": True, "forgotten": forgotten})
        return None

    if ftype == "memory_search":
        # 主动翻记忆:与 pre-step 注入同一套检索(含强化 —— 「翻记忆」
        # 就是「想起」,间隔效应照常适用;这是特性不是副作用)。
        user_id = str(frame.get("userId") or "")
        query = str(frame.get("query") or "").strip()
        if not user_id or not query:
            send(error_frame(req_id, "userId and query required"))
            return None
        top_k = int(frame.get("topK") or 6)
        now_val = frame.get("now")
        try:
            conn = _db_conn(state)
            try:
                # dedupe=False(RT4):搜索工具是**查全**用途,折叠近重复会少报。
                items, reinforced = retrieve.retrieve(
                    conn, user_id, query, top_k,
                    now=(float(now_val) if now_val else None), dedupe=False,
                    # 2026-10-08:补上漏传的 core_block —— 与 pre-step 注入路径(worker.py:215)
                    # 同一来源(retrieve.PROD_CORE_BLOCK=True);retrieve 的默认是 False,
                    # 而 retrieve.py:492 的注释「枚举路径也照"独立区块"排版」正是为这条
                    # (dedupe=False 的枚举)路径写的 ⇒ 作者写了、这里忘了接。
                    core_block=retrieve.PROD_CORE_BLOCK)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "memory_search failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "memory_search_result",
              "items": [
                  {"memoryId": it["memory_id"],
                   "summary": str(it.get("summary") or "")[:120],
                   "layer": str(it.get("layer") or ""),
                   "keywords": it.get("keywords") or [],
                   "hits": it.get("hits"),
                   "ageDays": it.get("age_days"),
                   "emotionScore": it.get("emotion_score")}
                  for it in items],
              "reinforced": reinforced})
        return None

    # ---- v0.14.5 S9 记忆治理(TTL 扫描)----

    if ftype == "episodic_cleanup":
        # 超 TTL 且情感分 <6 软删 + 3×TTL 死行物理清(A
        # `_cleanup_stale_memories` 逐字)。壳侧每 cleanup_every 次成功
        # 写入叫一次 —— 扫描挂在写入节奏上,不另起时钟。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        ttl_days = int(frame.get("ttlDays") or 30)
        now_val = frame.get("now")
        try:
            conn = _db_conn(state)
            try:
                removed = episodic.cleanup_stale(
                    conn, user_id, ttl_days,
                    now=(float(now_val) if now_val else None))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "episodic_cleanup failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "episodic_cleanup_result",
              "removed": removed, "ttlDays": ttl_days})
        return None

    if ftype == "episodic_clear":
        # v0.15.1 G14:整库清空(不可逆)。**确认在壳侧** —— 这里只认
        # `confirm: true` 这一个信号,没带就拒绝执行(A `/mem_clear` 要求
        # 二次确认,同一条纪律;壳侧的 echo_memory_clear 工具与面板按钮
        # 各自负责拿到这个 true)。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        if frame.get("confirm") is not True:
            send(error_frame(req_id, "episodic_clear requires confirm=true"))
            return None
        # (v0.29.0:includeMembers 随群聊退役 —— 单用户下本来就是同一次清理)
        try:
            conn = _db_conn(state)
            try:
                stats = episodic.clear_all(conn, user_id)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "episodic_clear failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "episodic_clear_result",
              "episodic": int(stats.get("episodic") or 0),
              "profile": int(stats.get("profile") or 0)})
        return None

    # ---- M2-b5 反思整固(真实引擎)----

    if ftype == "reflection_prompt":
        # 触发判定 + 提示词组装(壳拿去跑 LLM)。候选窗口存 state,
        # commit 帧据此校验 evidence_ids —— 两帧之间窗口不漂移。
        owner = str(frame.get("userId") or "")
        if not owner:
            send(error_frame(req_id, "userId required"))
            return None
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        try:
            conn = _db_conn(state)
            try:
                # v0.22.0:面板可覆盖整固的两只旋钮(A 的
                # reflection_importance_threshold / reflection_max_inputs)。
                # 不带 config = 引擎默认 30/50,老行为不变。
                rcfg = frame.get("config")
                rcfg = rcfg if isinstance(rcfg, dict) else {}
                result = reflection.check(
                    conn, owner, now=now,
                    importance_threshold=rcfg.get("importanceThreshold"),
                    max_inputs=rcfg.get("maxInputs"))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "reflection_prompt failed: " + str(exc)))
            return None
        if result.get("triggered"):
            state.setdefault("reflection_rounds", {})[owner] = result
        result = dict(result)
        result.pop("candidateScores", None)  # 内部状态,不上线
        result["reqId"] = req_id
        result["type"] = "reflection_prompt_result"
        send(result)
        return None

    if ftype == "reflection_commit":
        # 守卫落库 + 推游标。items 非空才推进游标(空=下轮重试)。
        owner = str(frame.get("userId") or "")
        items = frame.get("items")
        if not owner:
            send(error_frame(req_id, "userId required"))
            return None
        round_state = state.get("reflection_rounds", {}).pop(owner, None)
        if round_state is None:
            send(error_frame(req_id, "no active reflection round"))
            return None
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        try:
            conn = _db_conn(state)
            try:
                ack = reflection.commit(conn, owner, items, round_state, now=now)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "reflection_commit failed: " + str(exc)))
            return None
        ack["reqId"] = req_id
        ack["type"] = "reflection_commit_result"
        send(ack)
        return None

    # ---- M2-f 想念值(真实引擎)----

    if ftype == "longing_check":
        # 想念真值 + 三重闸门(M3 心跳与面板共用:读即刷新补差)。
        # config 由壳携带(面板配置),缺省用论文推荐值。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        cfg = longing.merge_config(frame.get("config"))
        try:
            conn = _db_conn(state)
            try:
                ok, st = longing.should_care(conn, user_id, now=now, cfg=cfg)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "longing_check failed: " + str(exc)))
            return None
        st = dict(st)
        st["shouldCare"] = ok
        st["reqId"] = req_id
        st["type"] = "longing_result"
        send(st)
        return None

    if ftype == "longing_message":
        # 用户来消息:脉冲削减 + 锚点重置 + 冷启动回填(M3 接线)。
        # v0.6.0 先读后削:削减前的想念(她等你时的值)随帧返回 ——
        # 壳侧 pre-step 注入【想念】行。语义与 AstrBot 相同:人到了,
        # 想念才落地;开口前她先知道自己有多想你。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        cfg = longing.merge_config(frame.get("config"))
        pre = None
        post = None
        try:
            conn = _db_conn(state)
            try:
                # v0.19.0 D2:pre 走 due_snapshot —— 除了削减前的想念值,
                # 还带回 threshold(心境调制后)与 due(≥阈值却没说出口),
                # 供壳侧 `agent/turn-stopping` 的硬保证判定。用 pre 而不是
                # post:问的是"他开口之前她有多想你"。
                pre = longing.due_snapshot(conn, user_id, now=now, cfg=cfg)
                longing.on_message(conn, user_id, now=now, cfg=cfg,
                                   text=frame.get("text"),
                                   session_id=str(frame.get("sessionId") or ""))
                post = longing.get_longing(conn, user_id, now=now, cfg=cfg)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "longing_message failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "longing_message_result", "ok": True,
              "pre": pre, "post": post})
        return None

    if ftype == "longing_care":
        # 关怀已发出:×0.5 缓解 + 锚点重置(发送成功才调 —— 与议程簿
        # 同款调用方纪律)。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        cfg = longing.merge_config(frame.get("config"))
        try:
            conn = _db_conn(state)
            try:
                longing.on_care_sent(conn, user_id, now=now, cfg=cfg)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "longing_care failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "longing_care_result", "ok": True})
        return None

    if ftype == "longing_tick":
        # 时钟驱动补差 + 抗议尖峰(壳侧心跳调;读即刷新已覆盖面板)。
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        cfg = longing.merge_config(frame.get("config"))
        try:
            conn = _db_conn(state)
            try:
                updated = longing.tick(conn, now=now, cfg=cfg)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "longing_tick failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "longing_tick_result", "updated": updated})
        return None

    # ---- M2-b1 悬置话题(真实引擎,已脱离 stub)----

    if ftype == "threads_due":
        # 被动注入:按人取「已到期+带时间」,取走即算提过(follow_up_after
        # 归零)—— AstrBot 同语义:放进 prompt 就算提过,同一件事不会被
        # 追问第二次。宁可漏提,不烦人。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        limit = int(frame.get("limit") or 4)
        now_val = frame.get("now")
        try:
            conn = _db_conn(state)
            try:
                items = threads.list_due_pending_threads(
                    conn, user_id,
                    now_ts=(float(now_val) if now_val else None),
                    limit=limit,
                )
                for item in items:
                    threads.mark_pending_thread_mentioned(conn, item["thread_id"])
            finally:
                conn.close()
        except Exception as exc:  # 引擎异常是应答,不是崩溃
            send(error_frame(req_id, "threads_due failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_due_result", "items": items})
        return None

    if ftype == "threads_remindable":
        # 主动提醒候选:全局「已到期+带时间+带会话」,纯读不落账 ——
        # 发送成功才由壳回 threads_mark(发送失败留池重试)。
        limit = int(frame.get("limit") or 3)
        now_val = frame.get("now")
        try:
            conn = _db_conn(state)
            try:
                items = threads.list_remindable_threads(
                    conn, now_ts=(float(now_val) if now_val else None),
                    limit=limit,
                )
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_remindable failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_remindable_result", "items": items})
        return None

    if ftype == "threads_mark":
        # 发送成功落账:提过一次,归零,不再追问。
        thread_id = frame.get("threadId")
        if thread_id is None:
            send(error_frame(req_id, "threadId required"))
            return None
        try:
            conn = _db_conn(state)
            try:
                threads.mark_pending_thread_mentioned(conn, int(thread_id))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_mark failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_mark_result", "ok": True})
        return None

    if ftype == "threads_ingest":
        # 反思路径的原子入口:先消解(用户原话)后登记(结构化产出)。
        # 顺序纪律在引擎侧单点强制 —— 顺序反了,新话题会被用户原话
        # 立刻关掉(main.py:889-911 的教训写进结构)。
        # items 的 followUpAfter 是 epoch 秒(相对时间由壳/b4 Judge 换算)。
        # v0.14.1 F4:命令式提醒允许壳只给原话(followUpAfterText)——
        # 时间解析留在引擎(timeutil 单一事实源);requireTime 项换算
        # 不出时间就丢弃(A 侧 main.py:2086 同款纪律:没有时间的约定
        # 归被动提及管,不归主动提醒)。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        text = str(frame.get("text") or "")
        session_id = str(frame.get("sessionId") or "")
        items = frame.get("items")
        if not isinstance(items, list):
            items = []
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        try:
            conn = _db_conn(state)
            try:
                resolved = threads.resolve_pending_thread(conn, user_id, text)
                results = []
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    due = 0.0
                    try:
                        due = max(0.0, float(item.get("followUpAfter") or 0.0))
                    except (TypeError, ValueError):
                        due = 0.0
                    if due <= 0 and item.get("followUpAfterText"):
                        try:
                            due = max(0.0, float(timeutil.resolve_follow_up_time(
                                str(item.get("followUpAfterText")), now=now)))
                        except Exception:
                            due = 0.0
                    if item.get("requireTime") and due <= 0:
                        continue
                    tid, created = threads.remember_pending_thread(
                        conn, user_id,
                        str(item.get("content") or ""),
                        due,
                        int(item.get("sourceMemoryId") or 0),
                        session_id,
                        # v0.18.2 C4:±120s 到期防重(A 侧 main.py:2088-2094)。
                        # 命令式提醒那一项由壳传 120 —— 与 Judge 登记的同一场
                        # 约定(措辞不同)合并,不留两条、不催办两次。
                        due_window_sec=float(item.get("dueWindowSec") or 0.0),
                    )
                    results.append({"threadId": tid, "created": created})
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_ingest failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_ingest_result",
              "resolved": resolved, "threads": results})
        return None

    if ftype == "threads_done":
        # 人工关闭一条悬置话题(A `main.py:2383-2392` 的 /threads done)。
        # 走的就是 Judge 平时那条 resolve_pending_thread —— 同一把尺子,
        # 不另造一套匹配规则。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        try:
            conn = _db_conn(state)
            try:
                tid = threads.resolve_pending_thread(
                    conn, user_id, str(frame.get("query") or ""))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_done failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_done_result", "threadId": tid})
        return None

    if ftype == "threads_add":
        # 人工登记一条**不带时间**的悬置话题(A `main.py:2394-2407`)。
        # follow_up_after=0 → 永远不主动提,只是留个记录;这正是
        # 「跟进」与「待办清单」的分界线(A :2397 的原话)。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        try:
            conn = _db_conn(state)
            try:
                tid, created = threads.remember_pending_thread(
                    conn, user_id, str(frame.get("content") or ""), 0.0,
                    session_id=str(frame.get("sessionId") or ""))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_add failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_add_result",
              "threadId": tid, "created": created})
        return None

    if ftype == "threads_restore":
        # 2026-10-06 D5:人工"恢复"—— 把一条**冷却中**的话题拉回活跃。
        # (已归档/被取代/已了结的不给恢复:那是语义上的终态,理由见 threads.py。)
        try:
            conn = _db_conn(state)
            try:
                restored = threads.restore_pending_thread(
                    conn, frame.get("threadId") or 0)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_restore failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_restore_result", "restored": restored})
        return None

    if ftype == "threads_list":
        # 面板:全部 open(定时的在前,不定时垫底)。带 now 让壳算
        # secondsLeft 时免受双机时钟偏差之苦。
        user_id = str(frame.get("userId") or "")
        if not user_id:
            send(error_frame(req_id, "userId required"))
            return None
        limit = int(frame.get("limit") or 20)
        try:
            conn = _db_conn(state)
            try:
                items = threads.list_open_pending_threads(conn, user_id, limit=limit)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_list failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_list_result",
              "items": items, "now": time.time()})
        return None

    if ftype == "threads_lifecycle":
        # 2026-10-06 D2:悬置话题生命周期(**影子期**)。
        # 只盖 `cooling_at` / `archived_at` 两列:不动 status、不动 updated_at、
        # 不删行;读出侧这一阶段一行都不引用它们(D3 才让注入侧按它过滤)。
        # `now` 由壳下发(与 threads_list 同一条纪律:免双机时钟偏差);
        # `dryRun=true` 只算不写(影子比对用,每天一拍)。
        try:
            conn = _db_conn(state)
            try:
                out = threads.cool_then_archive(
                    conn, frame.get("now"), dry_run=bool(frame.get("dryRun")))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "threads_lifecycle failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "threads_lifecycle_result",
              "cooled": out["cooled"], "archived": out["archived"],
              "scanned": out["scanned"], "now": out["now"],
              "dryRun": out["dryRun"]})
        return None

    # ---- M2-b2 图谱(真实引擎)----

    if ftype == "graph_learn":
        # 写入侧:三元组学习(与情景记忆共用 Judge 字段与同一个 I)。
        # owner_key 必填:归属隔离由调用点显式声明(DSH 约定 'master')。
        owner = str(frame.get("userId") or "")
        if not owner:
            send(error_frame(req_id, "userId required"))
            return None
        triples = frame.get("triples")
        if not isinstance(triples, list):
            triples = []
        emotion = float(frame.get("emotion") or 5.0)
        try:
            conn = _db_conn(state)
            try:
                learned = graph.learn(conn, triples, owner, emotion=emotion)
                # ── 阶段 1b/3a:写入侧去噪闸门(影子边专用,默认关)──────────────
                # 开关 = 两路 OR(默认关;每帧现读,不改任何文件):
                #   ① 环境变量 ECHO_GRAPH_GATE(优先;改它要重启宿主);
                #   ② 插件设置文件 $DSH_HOME/echo/config.json 顶层 graphShadowEdges
                #      —— 网页面板拨的那一路:拨一下,**下一帧判定就是新的**
                #      (文件每帧现读、不缓存 ⇒ 不重启、不热重载)。
                # 关掉时**连库都不读**(挖边也不做)、直接返回 ⇒ 与现状逐位一致;
                # 开着时**只吃影子边候选**(cooccur_*/temporal),候选由 3a 的挖边
                # 逻辑给:**刚写入的那条记忆** ⇒ 同记忆共现候选(只读、只挖既有节点,
                # 绝不建节点)。事实边(上面 graph.learn 写的那批三元组)
                # **不经过闸门**,绝不被拦。
                # 闸门自身出错**不静默**:它自己会尽量留一条 `internal-error` 回执
                # (回执表不可用才退化 stderr 全量回溯,不截断);这里兜底只为
                # "写入主流程绝不被图挂住"。
                try:
                    candidates = None
                    if graph_gate.gate_enabled():
                        candidates = graph_mine.candidates_for_latest_memory(
                            conn, memory_id=frame.get("memoryId"))
                    # 卡口 1(方案 A):影子边**独立归属键** —— 传 `owner` 会让它们
                    # 进检索(`load(owner)` → graph_activate → 人格注入)。
                    # P1c:名字集合由壳侧 names.json 经帧下发(帧里没有 ⇒ 空集合口径)。
                    _speakers, _person_names = graph_gate.names_from_frame(frame)
                    graph_gate.maybe_gate_shadow_edges(conn, graph_gate.SHADOW_OWNER,
                                                       candidates=candidates,
                                                       speakers=_speakers,
                                                       person_names=_person_names)
                except Exception as gate_exc:
                    print("[echo-worker] 影子边闸门失败(已跳过,写入不受影响):"
                          + str(gate_exc), file=sys.stderr)
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "graph_learn failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "graph_learn_result", "learned": learned})
        return None

    if ftype == "graph_query":
        # 读取侧 = AstrBot 大脑1 的图部分:load → 直扫打底 → LLM 种子
        # (壳传 extraSeeds)实体链接补充 → 机械切分兜底 → BFS → 渲染。
        # 返回的 hitEdgeIds/ltpEdgeIds 是「本轮想起」的预计算口径:
        #   hitEdgeIds = seed_edge_ids ∪ 非pinned路径边(Archived 唤醒通道在内)
        #   ltpEdgeIds = 仅非pinned路径边(LTP 只打路径边 —— AstrBot 同款)
        # 壳在轮末把这两个集合原样回传 graph_reinforce。
        owner = str(frame.get("userId") or "")
        if not owner:
            send(error_frame(req_id, "userId required"))
            return None
        text = str(frame.get("text") or "")
        top_k = int(frame.get("topK") or graph.ACTIVATION_TOP_K)
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        extra = frame.get("extraSeeds")
        try:
            conn = _db_conn(state)
            try:
                # F10(2026-09-27):同义谓词先并掉 —— 必须在 load 之前。
                # 也让 F11/F12 的层标判断只面对一条规范边(否则「就读于/读于/
                # 就读专业」三条会被一起提到 L0,面板上还是三根并排的线)。
                graph.merge_relation_variants(conn, owner)
            except Exception as exc:
                print("echo-engine: 谓词归并失败(已忽略): " + str(exc), file=sys.stderr)
            try:
                # F11/F12(2026-09-27):L0 图位治理。幂等,且**必须在 load 之前** ——
                # 降级/提升要在本轮生效,否则这一轮的 pinned 还是那两条章鱼小丸子。
                # 走插件自己的代码路径(不靠谁手改 echo.db),与 F3 的修复同一纪律。
                try:
                    l0_tier.migrate(conn, owner)
                except Exception as exc:      # 治理失败不该让图整段掉线
                    print("echo-engine: L0 图位治理失败(已忽略): " + str(exc),
                          file=sys.stderr)
                nodes_by_id, nodes_by_name, edges = graph.load(conn, owner)
                # 种子三通道,顺序即优先级:字面命中 → LLM 种子链接 → 机械兜底
                graph_seeds = graph.direct_seed_hits(text, nodes_by_name)
                raw_seeds = [str(s) for s in extra if str(s).strip()] \
                    if isinstance(extra, list) and extra \
                    else graph.extract_seed_nodes(text)
                for s in graph.match_seeds_to_graph(raw_seeds, nodes_by_name):
                    if s not in graph_seeds:
                        graph_seeds.append(s)
                paths, seed_edge_ids = graph.graph_activate(
                    graph_seeds, nodes_by_id, nodes_by_name, edges, now_ts=now,
                    top_k=top_k,
                )
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "graph_query failed: " + str(exc)))
            return None
        paths_text = graph.render_paths(paths)
        ltp_edge_ids = set()
        hit_edge_ids = set(seed_edge_ids)
        pinned_count = 0
        for p in paths:
            if p.get("pinned"):
                pinned_count += 1
                continue  # pinned 不算想起:不进 hit,不做 LTP
            for eid in p.get("edge_ids", []):
                if eid is not None:
                    ltp_edge_ids.add(int(eid))
                    hit_edge_ids.add(int(eid))
        send({"reqId": req_id, "type": "graph_query_result",
              "pathsText": paths_text,
              "seedNames": graph_seeds,
              "hitEdgeIds": sorted(hit_edge_ids),
              "ltpEdgeIds": sorted(ltp_edge_ids),
              "seedEdgeIds": sorted(seed_edge_ids),
              "pinnedCount": pinned_count,
              "now": now})
        return None

    if ftype == "graph_reinforce":
        # 轮末持久化 = apply_ltp(权重增强,不写时钟) + recall_updates
        # (H 增益/R 归 1/次数+1/时钟前移) + 10min 物化桶(跳过本轮命中)
        # + 1h 剪枝桶(豁免本轮命中 + 孤点清理)。
        # 桶状态存 state,跨帧持久(同一 worker 生命周期内节流)。
        hit = frame.get("hitEdgeIds")
        ltp = frame.get("ltpEdgeIds")
        hit_ids = {int(e) for e in hit if isinstance(hit, list)} if isinstance(hit, list) else set()
        ltp_ids = {int(e) for e in ltp if isinstance(ltp, list)} if isinstance(ltp, list) else set()
        is_master = bool(frame.get("isMaster") if frame.get("isMaster") is not None else True)
        now_val = frame.get("now")
        now = float(now_val) if now_val else time.time()
        try:
            conn = _db_conn(state)
            try:
                ltp_count = graph.apply_ltp(conn, ltp_ids, is_master)
                result = graph.update_and_persist(
                    conn, hit_ids, now, buckets=state.setdefault("graph_buckets", {}))
            finally:
                conn.close()
        except Exception as exc:
            send(error_frame(req_id, "graph_reinforce failed: " + str(exc)))
            return None
        send({"reqId": req_id, "type": "graph_reinforce_result",
              "ltp": ltp_count, "reinforced": len(result.get("changed", [])),
              "materialized": result.get("materialized", False),
              "pruned": result.get("pruned", 0), "edges": result.get("edges", 0)})
        return None

    if ftype == "shutdown":
        uptime_ms = int((time.monotonic() - state["started_at"]) * 1000)
        send({"reqId": req_id, "type": "bye", "uptimeMs": uptime_ms})
        return "bye"

    # 未知帧:协议对上了但帧没对上 —— 前向兼容,报错不断线
    send(error_frame(req_id, "unknown frame type: " + str(ftype)))
    return None


# ---- 帧字段归一(v0.42.0 审计修复 P1:坏值不许把 worker 打死) ----
#
# 现场:每个 handler 各自 `int(frame.get("topK") or 6)` / `float(frame.get("now"))`。
# 只要递来一个坏值("topK": "abc" / null / []),就是 ValueError —— 而 `handle()`
# 在 `main()` 里**没有** try/except,异常直接带 traceback 退出进程:壳那边看到的
# 是 EOF(被判成"worker 崩了"),这次请求的错因也一起丢了,而且在她说话的中途
# 整个记忆引擎掉线。两层防线:
#   ① 入口把已知数值字段提前归一(坏值 ⇒ 丢掉这个键,handler 自然走默认值);
#   ② main 里给 handle() 加兜底(漏网异常 ⇒ 一条 error 帧,进程活着)。
# 与文件自己的纪律一致:「引擎异常是应答,不是崩溃」。
_NUMERIC_FIELDS = {"topK": int, "limit": int, "ttlDays": int, "emotion": float, "now": float}


def _coerce_numeric(frame):
    """把已知数值字段归一成 int/float;坏值丢掉(让 handler 用默认值)而不是抛。"""
    for key, cast in _NUMERIC_FIELDS.items():
        if key not in frame:
            continue
        raw = frame[key]
        if raw is None or raw == "":
            frame.pop(key, None)
            continue
        try:
            frame[key] = cast(raw)
        except (TypeError, ValueError):
            diag("bad numeric field %s=%r -- falling back to default" % (key, raw))
            frame.pop(key, None)
    return frame


class _WireError:
    """读线程发现的协议级错误:塞回队列,由业务线程回帧。

    读线程**不碰 stdout** —— 这样 send() 永远只有一个写者,不需要加锁。
    """

    __slots__ = ("message", "fatal")

    def __init__(self, message, fatal=False):
        self.message = message
        self.fatal = fatal


_EOF = object()  # stdin 关闭哨兵:读线程放到队尾,业务线程据此退场


def _read_loop(inbox):
    """stdin 读线程:唯一碰 stdin 的地方。

    只做两件事:
      1. `cancel` 帧 → 立刻交给 engine.cancel 置位(**带外**,不等当前请求
         跑完。这正是本线程存在的全部理由);
      2. 其余帧 → 原样入队,业务线程按原来的串行语义处理。

    解析失败的帧不在这里回错误,而是包成 _WireError 入队 —— 保持 stdout
    单写者。
    """
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue  # 空行:管道心跳噪音,直接吞
            if len(line) > MAX_LINE:
                inbox.put(_WireError("frame exceeds 1MiB limit", fatal=True))
                return
            try:
                frame = json.loads(line)
            except ValueError:
                diag("dropped bad json: " + line[:120])
                inbox.put(_WireError("bad json line"))
                continue
            if not isinstance(frame, dict):
                inbox.put(_WireError("frame must be a json object"))
                continue
            if frame.get("type") == "cancel":
                # 不回帧:应答走 target 自己的 reqId 通道
                # ({"reqId": target, "type": "cancelled"})。
                if not cancel.mark(frame.get("targetReqId")):
                    diag("ignored cancel with bad targetReqId")
                continue
            inbox.put(frame)
    except Exception as exc:  # 读线程炸了也要让业务线程能退场,不能挂死
        diag("read loop failed: " + str(exc))
    finally:
        inbox.put(_EOF)


def main():
    # Windows 默认 GBK:中文帧必炸,显式切 UTF-8(reconfigure,≥3.7)
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    state = {"ready": False, "started_at": time.monotonic()}
    inbox = queue.Queue()
    reader = threading.Thread(target=_read_loop, args=(inbox,), name="echo-stdin", daemon=True)
    reader.start()

    while True:
        item = inbox.get()
        if item is _EOF:
            break
        if isinstance(item, _WireError):
            send(error_frame(None, item.message, fatal=item.fatal))
            if item.fatal:
                return 1
            continue

        frame = _coerce_numeric(item)
        req_id = frame.get("reqId")
        # 登记当前请求,检查点据此判断「我被取消没有」。
        cancel.begin(req_id)
        try:
            # 开局检查:取消可能在这一帧还堵在队列里的时候就到了
            # (壳发完请求立刻 abort)。这种请求连活都不该干 —— 而且它是
            # 唯一能让「ping 这种没有长循环的帧」也可取消的检查点。
            cancel.checkpoint()
            verdict = handle(frame, state)
        except cancel.RequestCancelled:
            # 取消是正常控制流:回一帧让壳的 pending 落地。
            # 不记失败、不击杀 —— 那是请求超时的语义,别混。
            diag("cancelled reqId=%r type=%r" % (req_id, frame.get("type")))
            send({"reqId": req_id, "type": "cancelled"})
            verdict = None
        except Exception as exc:  # 兜底:引擎异常是应答,不是崩溃
            diag("handle failed on %r: %s" % (frame.get("type"), exc))
            send(error_frame(req_id, "internal error: " + str(exc)))
            verdict = None
        finally:
            cancel.end(req_id)

        if verdict == "fatal":
            return 1
        if verdict == "bye":
            return 0
    # stdin EOF:壳没了,安静退场(不 bye —— 已经没有对端收它)
    return 0


if __name__ == "__main__":
    sys.exit(main())
