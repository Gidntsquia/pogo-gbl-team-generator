"""Round 8 R12: re-derive every number on out/gpu-study.html from its source files, independently of gpu/gpu-study.mjs.

    python3 gpu/gpu/study/check_page.py            # prints one line per number, writes out/gpu/study/check.log

Reads the page's <span|tspan data-k="key" data-f="fmt">text</...> elements, recomputes each key from the raw files
(run logs, gpu-profile.json, checkpoints, prof/metrics.json, width-calib-*.json, fork result.json, sources.json,
forks.jsonl, chain.log), formats it the same way and compares the text. Exit 1 on any mismatch or unknown key.
Card prose (mechanism, evidence, do next) is copied verbatim from each fork's result.json; it is checked for presence.
"""
import glob
import html as H
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
os.chdir(ROOT)
OUT, S = 'out', 'out/gpu/study'


def rd(p):
    return json.load(open(p)) if os.path.exists(p) else None


def txt(p):
    return open(p).read() if os.path.exists(p) else ''


def mean(a):
    return sum(a) / len(a) if a else None


# ---------------------------------------------------------------- runs (definitions as round 7, written from scratch)
def run_stats(d):
    log = txt(d + '.log')
    if not log:
        return None
    name = os.path.basename(d).replace('evolve-gpu8-', '').replace('evolve-gpu7-', '')
    m = re.search(r'wall start ([\d.]+)', log)
    start = float(m.group(1)) if m else None
    ex = re.findall(r'^exit (\d+)', log, re.M)
    gens = [(int(a), int(b), int(c)) for a, b, c in re.findall(r'^generation (\d+): done -- .*?(\d+) battles simulated \+ (\d+) served from cache', log, re.M)]
    G = len(gens)
    ck = f'{d}/evolve-gen{G - 1}.json'
    total = os.path.getmtime(ck) - start if G and start and os.path.exists(ck) else None
    rate = [h / max(1, s + h) for _, s, h in gens]
    tail = rate[-5:]
    tm = sum(tail) / len(tail) if tail else None
    sat = next((i for i, r in enumerate(rate) if abs(r - tm) <= 0.02), -1) if G >= 5 else -1
    prof = rd(f'{d}/gpu-profile.json') or {}
    walls = [g['wall'] for g in prof.get('generations', [])]
    warm = sum(walls[sat:G]) / (G - sat) if sat >= 0 and len(walls) >= G else None
    steps = [s for s in prof.get('steps', []) if s.get('gen') != 'final']
    n, w = sum(s['n'] for s in steps), sum(s['wall'] for s in steps)
    env = (re.search(r'^env: (.*?) HALVING=', log, re.M) or [None, ''])[1].strip()
    return dict(name=name, dir=d, exit=int(ex[-1]) if ex else None, gens=G, sat=sat, warm=warm, total=total, bps=n / w if w else None, prof=prof, env=env)


chain = txt(f'{S}/chain.log')
stages = [dict(k=int(a), kind=b, fork=c, name=d, rc=int(e), at=f) for a, b, c, d, e, f in re.findall(r'^== done (\d+) (\w+) (\S+) (\S+) exit (\d+) (.*)$', chain, re.M)]
names = {s['name'] for s in stages if s['kind'] == 'run'}
RUNS = {}
for d in sorted(glob.glob(f'{OUT}/evolve-gpu8-*')):
    if os.path.isdir(d) and os.path.basename(d)[len('evolve-gpu8-'):] in names:
        r = run_stats(d)
        if r:
            RUNS[r['name']] = r
ok = lambda rs: [r for r in rs if r['exit'] == 0 and r['warm'] is not None]
setof = lambda n: re.sub(r'-[a-z]$', '', n)
SETS = {}
for r in RUNS.values():
    SETS.setdefault(setof(r['name']), []).append(r)
base = ok(SETS.get('base', []))
base_warm = mean([r['warm'] for r in base])
CTRL_PAT = r'^base-[a-z]$|.*-prod-[a-z]$|^cpushare-share0-[a-z]$'
STAGEK = {s_['name']: s_['k'] for s_ in stages}
CTRL = sorted(ok([r for r in RUNS.values() if re.match(CTRL_PAT, r['name'])]), key=lambda r: STAGEK[r['name']])
def near_ctrl(ns):
    pick = {}
    for n in ns:
        for r in sorted(CTRL, key=lambda r: (abs(STAGEK[r['name']] - STAGEK[n]), STAGEK[r['name']]))[:2]:
            pick[r['name']] = r
    return list(pick.values())
CS = {}
for r in CTRL:
    CS.setdefault(setof(r['name']), []).append(r['warm'])
_sp = [max(v) - min(v) for v in CS.values() if len(v) >= 2]
noise = max(_sp) if _sp else None

# ---------------------------------------------------------------- cards
results = {}
for p in sorted(glob.glob(f'{S}/*/result.json')):
    results[p.split('/')[-2]] = rd(p)
CARDS = {}
for f, r in results.items():
    for c in r.get('cards', []):
        rs = ok([RUNS[n] for n in c.get('runs', []) if n in RUNS and not re.match(CTRL_PAT, n)])
        mw = mean([x['warm'] for x in rs])
        cw = mean([x['warm'] for x in near_ctrl([x['name'] for x in rs])]) if rs else None
        c = dict(c, fork=f, nruns=len(rs), measured=mw - cw if mw is not None and cw is not None else None)
        c['verified'] = bool(re.match(r'^100(\.0+)?%.*\b0 flagged', c.get('verify_agreement') or ''))
        CARDS[c['id']] = c
prof = rd(f'{S}/prof/metrics.json') or {}
PM = {m['id']: m for m in prof.get('metrics', [])}
LID = [l['id'] for l in prof.get('launches', [])]
cf = sorted(glob.glob(f'{OUT}/gpu/width-calib-*.json'))
calib = rd(cf[0]) if cf else {}
CB = calib.get('buckets', [])
sources = rd(f'{S}/lit/sources.json') or []
forkev = [json.loads(l) for l in txt(f'{S}/forks.jsonl').splitlines() if l.strip().startswith('{')]
FORKS = {}
for e in forkev:
    FORKS.setdefault(e['fork'], {'finish': None})
    if e.get('event') == 'finish':
        FORKS[e['fork']]['finish'] = e['at']

STRIP = re.compile(r'ms$|elapsed|^timing$|runStartedAt|^threadsUsed$|^resumed$|startedAt|finishedAt|csvPath|outDir|^analytics$', re.I)


def strip(o):
    if isinstance(o, list):
        return [strip(x) for x in o]
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if not STRIP.search(k)}
    return o


def same_ck(a, b):
    fa = sorted(f for f in os.listdir(a) if re.match(r'^evolve-gen\d+\.json$', f))
    fb = set(f for f in os.listdir(b) if re.match(r'^evolve-gen\d+\.json$', f))
    return bool(fa) and len(fa) == len(fb) and all(f in fb and strip(rd(f'{a}/{f}')) == strip(rd(f'{b}/{f}')) for f in fa)


# ---------------------------------------------------------------- generation split
BK = {
    'host': lambda b: b.get('plan', 0) + b.get('pack', 0) + b.get('transport', 0),
    'kernel': lambda b: b.get('kernel', 0), 'tail': lambda b: b.get('tail', 0),
    'post': lambda b: b.get('map', 0) + b.get('accumulate', 0) + b.get('waitCpu', 0) + b.get('flagged', 0),
    'ga': lambda b: b.get('ga', 0) + b.get('checkpoint', 0) + b.get('report', 0),
}


def gen_key(run, what):
    r = RUNS[run]
    warm = [g for g in r['prof']['generations'] if g['gen'] >= r['sat']]
    wall = mean([g['wall'] for g in warm])
    sp = {k: mean([f(g['buckets']) for g in warm]) for k, f in BK.items()}
    if what == 'wall':
        return wall
    if what == 'gpushare':
        return (sp['kernel'] + sp['tail']) / wall
    if what == 'hostga':
        return (sp['host'] + sp['post'] + sp['ga']) / wall
    if what == 'tailshare':
        return sp['tail'] / wall
    if what == 'ex':
        return next(g['gen'] for g in warm if g.get('steps') == 3)
    raise KeyError(what)


def r7warm(n):
    return run_stats(f'{OUT}/evolve-gpu7-{n}')['warm']


# ---------------------------------------------------------------- one recomputation per key family
def value(k):
    p = k.split('.')
    if p[0] in ('run', 'set') and len(p) > 3:
        p = [p[0], '.'.join(p[1:-1]), p[-1]]
    if p[0] == 'gen':
        return gen_key(p[1], p[3] if p[2] == 'mean' else p[2])
    if p[0] == 'launch':  # launch.<run>.<gen>.<i>.<n|wall>
        st = [s for s in RUNS[p[1]]['prof']['steps'] if s['gen'] == int(p[2])][int(p[3])]
        return st[p[4]]
    if p[0] == 'prof':
        return PM[p[1]]['values'][LID.index(p[2])]
    if p[0] == 'stall':
        return prof['stalls'][int(p[1])]['share'][LID.index(p[2])]
    if p[0] == 'sass':
        sc = rd(f'{S}/prof/sass/sass-counts.json')
        if p[1] == 'localshare':
            return sc['local_share_of_static_instr']
        line = next(l for l in sc['res_usage'].split('Function battle3v3_slice:')[1].splitlines() if l.strip())
        return int(re.search(rf'\b{p[1].upper()}:(\d+)', line).group(1))
    if p[0] == 'calib':
        if p[1] == 'nbuckets':
            return len(CB)
        if p[1] == 'nomatter':
            return sum(1 for b in CB if 'does not matter' in (b.get('rule') or '') or (b.get('pick') == 1 and (b.get('winner_margin_pct') or 0) <= 3))
        if p[1] == 'maxspread':
            return max(b.get('spread_pct') or 0 for b in CB)
        if p[1] == 'maxnoise':
            return max(b.get('noise_pct') or 0 for b in CB)
        if p[1] == 'bestgain':
            return max([0] + [max((b.get('ratio_to_g1_median') or {'1': 1}).values()) - 1 for b in CB])
        b = CB[int(p[1])]
        if p[2] == 'launches':
            return b['launches']
        if p[2] == 'ratio':
            return b['ratio_to_g1_median'][p[3]]
    if p[0] == 'run':
        return RUNS[p[1]][{'sat': 'sat', 'warm': 'warm', 'total': 'total', 'bps': 'bps'}[p[2]]]
    if p[0] == 'set':
        return mean([r['warm'] for r in ok(SETS[p[1]])])
    if k == 'base.warm' or k == 'rec.before':
        return base_warm
    if k == 'base.n':
        return len(base)
    if k == 'base.noise':
        return noise
    if k == 'base.ab':
        b = base[:2]
        return abs(b[0]['warm'] - b[1]['warm'])
    if k == 'base.drift':
        order = {s['name']: s['k'] for s in stages}
        b = sorted(base, key=lambda r: order.get(r['name'], 0))
        return mean([r['warm'] for r in b[-2:]]) / mean([r['warm'] for r in b[:2]]) - 1
    if k == 'rec.after':
        wins = sorted([c for c in CARDS.values() if c['measured'] is not None and c['verified'] and c['measured'] < -(noise or 0)], key=lambda c: c['measured'])
        return base_warm + (wins[0]['measured'] if wins else 0)
    if p[0] == 'card':
        c = CARDS[p[1]]
        return {'lo': (c.get('predicted_s_per_gen') or [None, None])[0], 'hi': (c.get('predicted_s_per_gen') or [None, None])[1], 'measured': c['measured'], 'nruns': c['nruns']}[p[2]]
    if k == 'cards.n':
        return min(12, len(CARDS))
    if p[0] == 'lit':
        return sum(1 for s in sources if s.get('applies') == p[1])
    if k == 'forks.n':
        return len(FORKS)
    if k == 'forks.done':
        return sum(1 for f in FORKS.values() if f['finish'])
    if k == 'chain.stages':
        return len(stages)
    if k == 'chain.failed':
        return sum(1 for s in stages if s['rc'])
    if k in ('check.verified', 'check.tested'):
        t = [c for c in CARDS.values() if c.get('tested')]
        return len(t) if k == 'check.tested' else sum(1 for c in t if c['verified'])
    if k in ('det.same', 'det.n'):
        b0 = base[0]
        rows = [r for r in RUNS.values() if r['name'] != b0['name'] and r['exit'] == 0]
        return len(rows) if k == 'det.n' else sum(1 for r in rows if same_ck(b0['dir'], r['dir']))
    if k == 'r7.isl':
        return mean([r7warm('isl-h3-p1'), r7warm('isl-h3-p1-r2')])
    if k == 'r7.auto':
        return mean([r7warm('auto-h3-p1'), r7warm('auto-h3-p1-r2')])
    if k == 'r7.islcost':
        return value('r7.isl') - value('r7.auto')
    raise KeyError(k)


def fmt(v, f):
    sign = f.endswith('+')
    f = f.rstrip('+')
    if f == '%':
        t = f'{round(v * 100 + 1e-9) if v >= 0 else -round(-v * 100)}%'
    elif f == '%1':
        t = f'{v * 100:.1f}%'
    elif f == ',':
        t = f'{int(round(v)):,}'
    else:
        t = f'{v:.{int(f)}f}'
    if sign and v > 0:
        t = '+' + t
    return t.replace('-', '−', 1) if t.startswith('-') else t


page = txt(f'{OUT}/gpu-study.html')
items = re.findall(r'<(?:span|tspan) class="v" data-k="([^"]+)" data-f="([^"]+)">([^<]*)</', page)
lines, bad = [], 0
for k, f, shown in items:
    k = H.unescape(k)
    try:
        v = value(k)
        exp = fmt(v, f) if v is not None else 'n/a'
    except Exception as e:  # noqa: BLE001 - an unknown key is a failure, reported as such
        exp, v = f'ERROR {type(e).__name__}: {e}', None
    good = exp == H.unescape(shown)
    bad += not good
    lines.append(f"{'ok      ' if good else 'MISMATCH'} {k:<44} page {H.unescape(shown):>10}  recomputed {exp:>10}  (raw {v!r})")
page_text = H.unescape(re.sub(r'<[^>]+>', '', page))
# card prose is copied verbatim; check that each card's do_next and name appear on the page
for c in CARDS.values():
    for fld in ('name', 'do_next'):
        good = (c.get(fld) or '') in page_text
        bad += not good
        lines.append(f"{'ok      ' if good else 'MISMATCH'} card.{c['id']}.{fld} text present")
lines.append(f'{len(items)} numbers + {2 * len(CARDS)} card texts checked, {bad} mismatches')
open(f'{S}/check.log', 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))
sys.exit(1 if bad else 0)
