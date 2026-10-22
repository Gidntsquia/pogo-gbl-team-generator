"""Cheap battle-length predictor for the time-sliced kernel (plans round 6, R3/R4; EXPERIMENTAL, off by default).

A linear model on log(solo battle time) over features read straight from the packed static / dyn arrays (no battle is run):
per side bulk (hp x def), fast-move damage rate, a time-to-KO estimate each way, charged-move count / cheapest energy,
buff moves, form changers, shields and bait settings. Fitted once on the 5,000 slice of a dumped run against each battle's
SOLO time (one warp per battle, LANES 32: no divergence) by `python -m gpu.sched_bench fit`; weights live in
predict-weights.json next to this file. Used to order the queue (POGO_GPU_BIN=on) and for the ahead deadline (POGO_GPU_AHEAD=on).
"""
import json
import os

import numpy as np

_W = os.path.join(os.path.dirname(__file__), "predict-weights.json")
NAMES = ["bias", "log_tankA", "log_tankB", "log_dmgA", "log_dmgB", "log_ttkA", "log_ttkB", "log_ttk_min", "log_ttk_max",
         "chargedA", "chargedB", "min_energyA", "min_energyB", "buffA", "buffB", "formA", "formB", "shieldsA", "shieldsB",
         "baitA", "baitB", "cdA", "cdB", "optA", "optB"]


def features(static, idx, dyn):
    """[n, len(NAMES)] float64 features for battles idx [n,6] (lead first, A = 0..2, B = 3..5), dyn [n,6,D_N]."""
    st = np.asarray(static)[np.asarray(idx)]           # [n,6,S_N]
    dy = np.asarray(dyn)
    hp = np.where(dy[:, :, 0] > 0, dy[:, :, 0], st[:, :, 2])
    atk, de = st[:, :, 0], st[:, :, 1]
    fpow, fcd = st[:, :, 31], np.maximum(st[:, :, 34], 500.0)
    rate = atk * np.maximum(fpow, 1.0) / (fcd / 500.0)
    ch = np.stack([st[:, :, 30 + 25 * (1 + k)] for k in range(3)], -1)          # charged slot present
    che = np.stack([st[:, :, 30 + 25 * (1 + k) + 2] for k in range(3)], -1)     # charged energy
    chb = np.stack([st[:, :, 30 + 25 * (1 + k) + 9] for k in range(3)], -1)     # charged has buffs
    minE = np.where(ch > 0, che, 1e3).min(-1)
    side = lambda a, s: a[:, 3 * s:3 * s + 3]
    tank = [np.log1p((side(hp, s) * side(de, s)).sum(1)) for s in (0, 1)]
    dmg = [np.log1p(side(rate, s).sum(1)) for s in (0, 1)]
    ttkA = tank[1] - dmg[0]   # time for A to take B down (log)
    ttkB = tank[0] - dmg[1]
    f = [np.ones(len(idx)), tank[0], tank[1], dmg[0], dmg[1], ttkA, ttkB, np.minimum(ttkA, ttkB), np.maximum(ttkA, ttkB)]
    for s in (0, 1):
        f.append(side(ch.sum(-1), s).sum(1))
    for s in (0, 1):
        f.append(np.log(side(minE, s).mean(1)))
    for s in (0, 1):
        f.append(side((chb * ch).sum(-1), s).sum(1))
    for s in (0, 1):
        f.append((side(st[:, :, 130], s) != 0).sum(1))
    for s in (0, 1):
        f.append(side(dy[:, :, 3], s)[:, 0])
    for s in (0, 1):
        f.append(side(dy[:, :, 10], s).sum(1))
    for s in (0, 1):
        f.append(np.log(side(fcd, s).mean(1)))
    for s in (0, 1):
        f.append(side(dy[:, :, 12], s).sum(1))
    return np.stack(f, 1)


def fit(X, y_s, ridge=1e-3):
    """Ridge fit of log(y_s) on standardized X (bias column untouched). Returns a weights dict."""
    mu, sd = X.mean(0), X.std(0)
    mu[0], sd[0] = 0.0, 1.0
    sd[sd == 0] = 1.0
    Z = (X - mu) / sd
    A = Z.T @ Z + ridge * len(Z) * np.eye(Z.shape[1])
    A[0, 0] -= ridge * len(Z)
    w = np.linalg.solve(A, Z.T @ np.log(np.maximum(y_s, 1e-6)))
    return {"names": NAMES, "mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist()}


def load(path=_W):
    return json.load(open(path)) if os.path.exists(path) else None


def predict_s(static, idx, dyn, weights=None):
    """Predicted SOLO battle time in seconds, [n]. None if no weights file exists."""
    w = weights or load()
    if w is None:
        return None
    X = features(static, idx, dyn)
    Z = (X - np.asarray(w["mu"])) / np.asarray(w["sd"])
    return np.exp(Z @ np.asarray(w["w"]))
