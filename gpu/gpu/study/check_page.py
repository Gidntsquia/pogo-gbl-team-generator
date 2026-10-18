"""Round 9 R7: check out/gpu-study.html against the raw files, on its own (no code shared with gpu/gpu-study.mjs).

    python3 gpu/gpu/study/check_page.py          -> out/gpu/study/check.log, exit 1 on any failure

1. Every number span (data-k) is recomputed here from the run logs, gpu-profile.json files, tail-timeline.json and the
   Nsight summary, and must match the page text to its last printed digit.
2. One label, one value: every span with the same data-k shows the same text (the page gives each quantity one key).
3. Verdict words: each data-verdict word must be what its own number says ("faster"/"slower" only when the change beats both
   spreads, else "no gain"), and the words "slower", "faster", "no gain" appear nowhere else in the visible page.
4. The page names one reference run set and every A/B run of it exists.
"""
import glob
import html.parser
import json
import os
import re
import sys

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
OUT = os.path.join(R, "out")
S = os.path.join(OUT, "gpu/study")
VAR = ["default", "tail", "certain"]


def jl(p):
    return json.load(open(p)) if os.path.exists(p) else None


# ---------------------------------------------------------------- raw recomputation (own definitions, from the plan)
def run(name):
    d = os.path.join(OUT, f"evolve-gpu8-{name}")
    log = open(d + ".log").read() if os.path.exists(d + ".log") else ""
    if not log:
        return None
    gens = [(int(a), int(b), int(c)) for a, b, c in re.findall(r"^generation (\d+): done -- .*?(\d+) battles simulated \+ (\d+) served from cache", log, re.M)]
    ex = re.findall(r"^exit (\d+)", log, re.M)
    prof = jl(os.path.join(d, "gpu-profile.json")) or {}
    G = len(gens)
    rate = [h / max(1, s + h) for _, s, h in gens]
    sat = -1
    if G >= 5:
        m = sum(rate[-5:]) / 5
        sat = next((i for i, r in enumerate(rate) if abs(r - m) <= 0.02), -1)
    gw = prof.get("generations", [])
    warm = sum(g["wall"] for g in gw[sat:G]) / (G - sat) if sat >= 0 and len(gw) >= G else None
    tail = sum(g["buckets"]["tail"] for g in gw[sat:G]) / sum(g["wall"] for g in gw[sat:G]) if sat >= 0 and len(gw) >= G else None
    start = float(re.search(r"wall start ([\d.]+)", log).group(1))
    total = os.path.getmtime(os.path.join(d, f"evolve-gen{G - 1}.json")) - start if G else None
    tl = re.findall(r"gpu tail -- pool (\d+), speculated (\d+) \((\d+) certain\), kept (\d+), discarded (\d+), overrun (-?\d+)us, served (\d+)", log)
    sv2 = re.findall(r"gpu tail -- served (\d+) from the previous launch \(no pool", log)
    late = sum(float(x) for x in re.findall(r"gpu tail late -- waited ([\d.]+)ms", log)) / 1e3
    steps = [s for s in prof.get("steps", []) if s.get("gen") != "final"]
    return {"exit": int(ex[-1]) if ex else None, "gens": G, "warm": warm, "tail": tail, "total": total, "start": start,
            "launches": sum(len(s.get("launches", [])) for s in steps) / G if G else None,
            "spec": sum(int(x[1]) for x in tl), "kept": sum(int(x[3]) for x in tl), "served": sum(int(x[6]) for x in tl) + sum(int(x) for x in sv2),
            "nl": len(tl), "late": late}


def expected():
    E = {}
    rounds = sorted({int(m) for m in (re.search(r"-(\d+)\.log$", f).group(1) for f in glob.glob(os.path.join(OUT, "evolve-gpu8-r9-ab-default-*.log")))
                     if all(os.path.exists(os.path.join(OUT, f"evolve-gpu8-r9-ab-{v}-{m}.log")) for v in VAR)})
    E["ab.rounds"] = len(rounds)
    st = {}
    for v in VAR:
        rs = [run(f"r9-ab-{v}-{i}") for i in rounds]
        for i, r in zip(rounds, rs):
            if r and r["exit"] == 0 and r["warm"] is not None:
                E[f"run.r9-ab-{v}-{i}.warm"] = r["warm"]
        ok = [r for r in rs if r and r["exit"] == 0 and r["warm"] is not None]
        w = [r["warm"] for r in ok]
        st[v] = {"mean": sum(w) / len(w), "spread": max(w) - min(w), "runs": ok} if w else None
        if w:
            E[f"ab.{v}.mean"], E[f"ab.{v}.spread"] = st[v]["mean"], st[v]["spread"]
            E[f"ab.{v}.tailshare"] = 100 * sum(r["tail"] for r in ok) / len(ok)
    if st["default"]:
        E["ab.default.launches"] = sum(r["launches"] for r in st["default"]["runs"]) / len(st["default"]["runs"])
    V = {}
    for v in ("tail", "certain"):
        if st[v] and st["default"]:
            d = st[v]["mean"] - st["default"]["mean"]
            E[f"ab.{v}.delta"] = d
            beats = abs(d) > st[v]["spread"] and abs(d) > st["default"]["spread"]
            V[f"ab.{v}.delta"] = "no gain" if not beats else ("faster" if d < 0 else "slower")
    if st["tail"]:
        ok = st["tail"]["runs"]
        nl = sum(r["nl"] for r in ok)
        spec = sum(r["spec"] for r in ok)
        E["ab.tail.latewait"] = sum(r["late"] / r["gens"] for r in ok) / len(ok)
        E["ab.tail.spec"] = spec / max(1, nl)
        E["ab.tail.keptpct"] = 100 * sum(r["kept"] for r in ok) / max(1, spec)
        E["ab.tail.servedpct"] = 100 * sum(r["served"] for r in ok) / max(1, spec)
    full = {v: run(f"r9-full-{v}") for v in VAR}
    for v, r in full.items():
        if r and r["exit"] == 0:
            E[f"full.{v}.min"], E[f"full.{v}.warm"], E[f"full.{v}.gens"] = r["total"] / 60, r["warm"], r["gens"]
    if full["tail"] and full["tail"]["exit"] == 0:
        E["full.tail.latewait"] = full["tail"]["late"]
    for v in ("tail", "certain"):
        if full[v] and full["default"] and full[v]["total"] and full["default"]["total"]:
            E[f"full.{v}.dmin"] = (full[v]["total"] - full["default"]["total"]) / 60
    tl = (jl(os.path.join(S, "prof/tail-timeline.json")) or {}).get("launches", {})
    for l, modes in tl.items():
        for m, r in modes.items():
            v = "default" if m == "off" else m
            E[f"tl.{l}.{v}.active"], E[f"tl.{l}.{v}.span"] = r["sm_active_share_pct"], r["main_span_s"]
    if "10k" in tl and "tail" in tl["10k"]:
        E["tl.10k.activegain"] = tl["10k"]["tail"]["sm_active_share_pct"] - tl["10k"]["off"]["sm_active_share_pct"]
        E["tl.10k.spangain"] = tl["10k"]["tail"]["main_span_s"] - tl["10k"]["off"]["main_span_s"]
    ncu = jl(os.path.join(S, "prof/ncu/summary.json")) or {}
    for key, o in (("5k", ncu.get("5k")), ("10k", ncu.get("10k")), ("5kon", (ncu.get("variants") or {}).get("5k-tailon"))):
        if not o or o.get("tool") == "no Nsight":
            continue
        for k, f in (("issue", "issue_slot_use_pct"), ("occ", "achieved_occupancy_pct"), ("localshare", "local_share_of_l1_bytes_pct"),
                     ("localgb", "local_bytes_gb"), ("kernel", "kernel_s_at_base_clock"), ("l1", "l1_hit_pct"), ("l2", "l2_hit_pct")):
            E[f"ncu.{key}.{k}"] = o.get(f)
        for s in o.get("top5_stalls", []):
            E[f"ncu.{key}.stall.{s['reason']}"] = s["share_pct"]
    return E, V, rounds


# ---------------------------------------------------------------- page parse
class P(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.spans, self.verdicts, self.text, self.cur = [], [], [], [], None

    def handle_starttag(self, tag, a):
        a = dict(a)
        self.stack.append((tag, a))
        if "data-k" in a:
            self.cur = ["k", a["data-k"], ""]
        elif "data-verdict" in a:
            self.cur = ["v", a["data-verdict"], ""]

    def handle_endtag(self, tag):
        while self.stack:
            t, a = self.stack.pop()
            if ("data-k" in a or "data-verdict" in a) and self.cur:
                (self.spans if self.cur[0] == "k" else self.verdicts).append((self.cur[1], self.cur[2].strip()))
                self.cur = None
            if t == tag:
                break

    def handle_data(self, d):
        if any(t in ("style", "script", "title") for t, _ in self.stack):
            return
        if self.cur:
            self.cur[2] += d
        else:
            self.text.append(d)


def parse_num(t):
    m = re.search(r"[−+-]?[\d,]*\.?\d+", t)
    if not m:
        return None, 0
    s = m.group(0).replace("−", "-").replace(",", "")
    dec = len(s.split(".")[1]) if "." in s else 0
    return float(s), dec


def main():
    page = open(os.path.join(OUT, "gpu-study.html")).read()
    p = P()
    p.feed(page)
    E, V, rounds = expected()
    lines, bad = [], 0
    # 1 + 2a
    shown = {}
    for k, t in p.spans:
        shown.setdefault(k, set()).add(t)
    for k, ts in sorted(shown.items()):
        if len(ts) > 1:
            bad += 1
            lines.append(f"FAIL two values for one label {k}: {sorted(ts)}")
        t = next(iter(ts))
        v, dec = parse_num(t)
        if k not in E or E[k] is None:
            bad += 1
            lines.append(f"FAIL {k} = {t}: no raw source recomputes it")
            continue
        exp = E[k]
        ok = v is not None and abs(v - exp) <= 0.5 * 10 ** -dec + 1e-9
        bad += not ok
        lines.append(f"{'ok  ' if ok else 'FAIL'} {k} page {t} raw {exp:.4f}")
    # 3
    for k, w in p.verdicts:
        exp = V.get(k)
        ok = exp == w
        bad += not ok
        lines.append(f"{'ok  ' if ok else 'FAIL'} verdict {k}: page '{w}', number says '{exp}'")
    loose = re.findall(r"[^.]*\b(slower|faster|no gain)\b[^.]*", " ".join(p.text), re.I)
    for x in loose:
        bad += 1
        lines.append(f"FAIL verdict word outside a checked verdict: '{x.strip()}'")
    # 4
    ref = re.search(r"Reference runs: the A/B started (\d{4}-\d\d-\d\d \d\d:\d\d) ET", page)
    ok = bool(ref) and len(rounds) >= 1
    bad += not ok
    lines.append(f"{'ok  ' if ok else 'FAIL'} reference run set named: {ref.group(1) if ref else 'missing'}, rounds {rounds}")
    lines.append(f"{len(shown)} labels, {len(p.verdicts)} verdicts, {bad} failures")
    open(os.path.join(S, "check.log"), "w").write("\n".join(lines) + "\n")
    print("\n".join(l for l in lines if not l.startswith("ok")))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
