# -*- coding: utf-8 -*-
"""LongMemEval 官方判定器(照抄官方口径,不自造)。

提示词**逐字来自官方仓库** `src/evaluation/evaluate_qa.py` 的 `get_anscheck_prompt`:
  * single-session-user / single-session-assistant / multi-session 共用一个模板;
  * temporal-reasoning 额外声明"天数的 off-by-one 不算错";
  * knowledge-update 额外声明"旧信息+新答案,只要新答案对就算对";
  * single-session-preference 用**评分细则(rubric)**而不是标准答案;
  * **abstention**:「给一个不可答的问题、一段说明、一个模型回答;若模型正确识别为不可答,答 yes」
    —— 正确行为可以是"说信息不足",也可以是"给了别的信息但没给被问的那条"。
调用与聚合口径同官方:单条 user 消息、temperature=0、max_tokens=10、`'yes' in 回复.lower()`。

输出:总体准确率 + 逐题型 + 拒答档,并落 `<hyp>.eval-results-<model>`(每行带 `autoeval_label`)。

两种用法:
  1) **官方数据**:`python scripts/judge-llm.py --ref .scratch/longmemeval_oracle.json --hyp hyp.jsonl`
     (hyp.jsonl 每行 `{"question_id": ..., "hypothesis": ...}`)
  2) **我们自己的金标**:`python scripts/judge-llm.py --ours --hyp-from-dump .scratch/l4-llm-cite.json`
     —— 把我们的档位按 §映射表 折进官方题型,答案文本用金标的 `note`(指认依据那一句),
        N0 负控落成 `_abs` 拒答题(说明="库里没有任何记忆提到该问题涉及的主题")。

⚠️ 判定模型与官方不同(官方是 gpt-4o-2024-08-06;这里默认走本机网关的 deepseek-v4-flash)
   ⇒ **与论文表格里的数字不可直接比**;同一批数据内部可比。
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# 2026-10-08:端点不再写死(发布纪律 —— 与"真昵称清零"同类:仓库里不该只属于某台机器的私有网关)。
# 用 ECHO_LLM_ENDPOINT 指;没设就给空串,由调用方明确报错,而不是偷偷连别人的网关。
DEFAULT_ENDPOINT = os.environ.get("ECHO_LLM_ENDPOINT", "")
DEFAULT_KEY_REF = "JICHUANG_OFFICE_API_KEY"
DEFAULT_MODEL = "deepseek-v4-flash"

# ---------------------------------------------------------------- 官方提示词(逐字)
T_COMMON = ("I will give you a question, a correct answer, and a response from a model. Please answer "
            "yes if the response contains the correct answer. Otherwise, answer no. If the response is "
            "equivalent to the correct answer or contains all the intermediate steps to get the correct "
            "answer, you should also answer yes. If the response only contains a subset of the "
            "information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\n"
            "Model Response: {}\n\nIs the model response correct? Answer yes or no only.")
T_TEMPORAL = ("I will give you a question, a correct answer, and a response from a model. Please answer "
              "yes if the response contains the correct answer. Otherwise, answer no. If the response is "
              "equivalent to the correct answer or contains all the intermediate steps to get the correct "
              "answer, you should also answer yes. If the response only contains a subset of the "
              "information required by the answer, answer no. In addition, do not penalize off-by-one "
              "errors for the number of days. If the question asks for the number of days/weeks/months, "
              "etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is "
              "18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\n"
              "Model Response: {}\n\nIs the model response correct? Answer yes or no only.")
T_UPDATE = ("I will give you a question, a correct answer, and a response from a model. Please answer "
            "yes if the response contains the correct answer. Otherwise, answer no. If the response "
            "contains some previous information along with an updated answer, the response should be "
            "considered as correct as long as the updated answer is the required answer.\n\nQuestion: "
            "{}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer "
            "yes or no only.")
T_PREF = ("I will give you a question, a rubric for desired personalized response, and a response from a "
          "model. Please answer yes if the response satisfies the desired response. Otherwise, answer "
          "no. The model does not need to reflect all the points in the rubric. The response is correct "
          "as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: "
          "{}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no "
          "only.")
T_ABS = ("I will give you an unanswerable question, an explanation, and a response from a model. Please "
         "answer yes if the model correctly identifies the question as unanswerable. The model could say "
         "that the information is incomplete, or some other information is given but the asked "
         "information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model "
         "correctly identify the question as unanswerable? Answer yes or no only.")

OFFICIAL_TYPES = ["single-session-user", "single-session-assistant", "single-session-preference",
                  "multi-session", "temporal-reasoning", "knowledge-update"]
# 我们的档 → 官方题型(见 docs/MEMORY_EVAL_PROTOCOL.md)
OUR_TIER2TYPE = {
    "N1 单会话事实": "single-session-user",
    "N2 多会话": "multi-session",
    "N3 时间推理": "temporal-reasoning",
    "N4 知识更新": "knowledge-update",
    "N5 矛盾消解": "multi-session",          # 官方无"矛盾"档,先折进多会话(文档里标明)
    "N6 偏好": "single-session-preference",
}
NEG_TIER = "N0 闲聊/负控"
ABS_EXPLANATION = "库中没有任何一条记忆提到该问题所问的信息(该题在逐字取题时指认不出任何答案)。"


def get_prompt(task, question, answer, response, abstention=False):
    if abstention:
        return T_ABS.format(question, answer, response)
    if task in ("single-session-user", "single-session-assistant", "multi-session"):
        return T_COMMON.format(question, answer, response)
    if task == "temporal-reasoning":
        return T_TEMPORAL.format(question, answer, response)
    if task == "knowledge-update":
        return T_UPDATE.format(question, answer, response)
    if task == "single-session-preference":
        return T_PREF.format(question, answer, response)
    raise NotImplementedError(task)


def load_key(ref=DEFAULT_KEY_REF):
    path = os.path.join(os.environ.get("DSH_HOME", os.path.join(os.path.expanduser("~"), ".dsh")),
                        ".credentials.yaml")
    try:
        txt = open(path, encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"(?m)^\s*%s\s*:\s*['\"]?([^\s'\"]+)" % re.escape(ref), txt)
    return m.group(1) if m else None


def judge(prompt, endpoint, key, model, cache, tries=3):
    ck = hashlib.sha1(("judge|%s|%s" % (model, prompt)).encode("utf-8")).hexdigest()
    if ck in cache:
        return cache[ck]
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}],
                       "temperature": 0, "max_tokens": 10}).encode("utf-8")
    out = ""
    for i in range(tries):
        try:
            req = urllib.request.Request(endpoint, data=body, headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": "Bearer %s" % key})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = (data["choices"][0]["message"]["content"] or "").strip()
            break
        except Exception:
            time.sleep(2.0 * (i + 1))
    cache[ck] = out
    return out


def load_ours_reference(answers_path=None):
    """我们的金标 → 官方形状的参考文件。

    参考答案优先用 `--answers`(人工确认过的**最小必需答案**);
    没给就退回金标的 `note`(指认依据)——⚠️ 那是**列举全部可接受记忆**的说明,
    会被官方规则「只答了子集 ⇒ no」压掉一片正确答案(实测 8/21 vs 15/21,见 §7.2)。
    """
    spec = importlib.util.spec_from_file_location(
        "retrieval_present", os.path.join(HERE, "retrieval-present.py"))
    pr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pr)
    env = pr.bootstrap(None)
    answers = {}
    if answers_path:
        answers = {int(k): v for k, v in json.load(open(answers_path, encoding="utf-8")).items()}
        print("最小必需答案:%d 条(%s)" % (len(answers), answers_path))
    refs, qid_of_gi = [], {}
    for gi, g in enumerate(env["golden"]):
        neg = not g["accept"]
        qtype = NEG_TIER if neg else OUR_TIER2TYPE.get(g["tier"], "multi-session")
        qid = "ours-%02d-%s%s" % (gi, qtype, "_abs" if neg else "")
        qid_of_gi[gi] = qid
        refs.append({"question_id": qid, "question_type": qtype, "question": g["query"],
                     "answer": ABS_EXPLANATION if neg else str(answers.get(gi) or g.get("note") or ""),
                     "tier": g["tier"], "accept": sorted(g["accept"] or [])})
    return refs, qid_of_gi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default=None, help="官方参考文件(如 .scratch/longmemeval_oracle.json)")
    ap.add_argument("--hyp", default=None, help="hypothesis jsonl(question_id/hypothesis)")
    ap.add_argument("--ours", action="store_true", help="用我们自己的金标当参考")
    ap.add_argument("--answers", default=None,
                    help="gi→最小必需答案 的 json(人工确认过的);不给就退回金标 note")
    ap.add_argument("--hyp-from-dump", default=None,
                    help="从 retrieval-present.py 的 dump 里取答案(默认取 R0现状|V0 现状顺序)")
    ap.add_argument("--dump-key", default=None)
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--key", default=None)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--cache", default=os.path.join(ROOT, ".scratch", "judge-cache.json"))
    args = ap.parse_args()

    key = args.key or load_key()
    if not key:
        print("[!] 取不到网关密钥(%s)⇒ 停(不自造判定)" % DEFAULT_KEY_REF)
        sys.exit(1)
    cache = {}
    if os.path.exists(args.cache):
        try:
            cache = json.load(open(args.cache, encoding="utf-8"))
            print("判定缓存:%d 条" % len(cache))
        except Exception:
            pass

    qid_of_gi = {}
    if args.ours:
        refs, qid_of_gi = load_ours_reference(args.answers)
    else:
        refs = json.load(open(args.ref, encoding="utf-8"))
    ref_by_qid = {r["question_id"]: r for r in refs}
    print("参考条目:%d(题型:%s)" % (len(refs), ", ".join(
        sorted({r["question_type"] for r in refs}))))

    if args.hyp_from_dump:
        dump = json.load(open(args.hyp_from_dump, encoding="utf-8"))
        dkey = args.dump_key or next(k for k in dump if k.endswith("|V0 现状顺序"))
        recs = dump[dkey]
        print("取答案:%s(%d 条)" % (dkey, len(recs)))
        hyps = [{"question_id": qid_of_gi[r["gi"]], "hypothesis": (r["ans"] or "").strip()}
                for r in recs if r.get("gi") in qid_of_gi]
    else:
        hyps = [json.loads(ln) for ln in open(args.hyp, encoding="utf-8") if ln.strip()]

    logs, per_type, abs_acc = [], {t: [] for t in OFFICIAL_TYPES}, []
    out_path = (args.hyp or args.hyp_from_dump or "ours") + ".eval-results-%s" % args.model
    with open(out_path, "w", encoding="utf-8") as fh:
        for i, e in enumerate(hyps):
            r = ref_by_qid.get(e["question_id"])
            if not r:
                print("  [!] 参考里没有 %s" % e["question_id"])
                continue
            is_abs = e["question_id"].endswith("_abs")
            p = get_prompt(r["question_type"], r["question"], r["answer"], e["hypothesis"], abstention=is_abs)
            raw = judge(p, args.endpoint, key, args.model, cache)
            label = "yes" in raw.lower()
            e["autoeval_label"] = {"model": args.model, "label": label}
            logs.append(e)
            print("  [%2d/%d] %-34s %s" % (i + 1, len(hyps), e["question_id"], "yes" if label else "no"),
                  flush=True)
            print(json.dumps(e, ensure_ascii=False), file=fh)
            (abs_acc if is_abs else per_type[r["question_type"]]).append(1 if label else 0)

    def mean(xs):
        return sum(xs) / len(xs) if xs else float("nan")

    print()
    print("=" * 66)
    print("  LongMemEval 官方判定口径(模型 = %s)" % args.model)
    print("=" * 66)
    print("  总体准确率: %.4f  (n=%d)" % (mean([1 if x["autoeval_label"]["label"] else 0 for x in logs]),
                                        len(logs)))
    for t in OFFICIAL_TYPES:
        v = [1 if x["autoeval_label"]["label"] else 0 for x in logs
             if not x["question_id"].endswith("_abs") and ref_by_qid[x["question_id"]]["question_type"] == t]
        if v:
            print("   %-28s %.4f  (%d)" % (t, mean(v), len(v)))
    if abs_acc:
        print("   %-28s %.4f  (%d)" % ("abstention(_abs)", mean(abs_acc), len(abs_acc)))
    print("  已写出: %s" % out_path)
    with open(args.cache, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False)


if __name__ == "__main__":
    main()
