"""Tests for gpu/scheduler.py (run: cd gpu && uv run python -m unittest gpu.test_scheduler). No GPU needed: `run` is a stub."""
import unittest

import numpy as np

from gpu.pack import D_N
from gpu.scheduler import InnerSimScheduler


def fake_run(static, idx, dyn, real="float"):
    """Deterministic stand-in kernel: 18 columns derived from the inputs."""
    out = np.zeros((len(idx), 18), np.int32)
    out[:, 0] = idx[:, 0] * 100 + idx[:, 1]
    out[:, 1] = dyn[:, 0, 0].astype(np.int32)
    return out


class SchedulerTest(unittest.TestCase):
    def mk(self, **kw):
        calls = []

        def run(*a):
            calls.append(len(a[1]))
            return fake_run(*a)

        return InnerSimScheduler(None, run=run, **kw), calls

    def req(self, a, b, hp):
        dyn = np.zeros((2, D_N))
        dyn[0, 0] = hp
        return [a, b], dyn

    def test_results_follow_tickets_and_duplicates_fold(self):
        s, calls = self.mk()
        t = [s.submit(*self.req(1, 2, 50)), s.submit(*self.req(3, 4, 60)), s.submit(*self.req(1, 2, 50))]
        self.assertEqual(s.pending, 3)
        res = s.flush()
        self.assertEqual(calls, [2])  # two distinct rows ran
        self.assertEqual([int(res[x][0]) for x in t], [102, 304, 102])
        self.assertEqual([int(res[x][1]) for x in t], [50, 60, 50])
        st = s.stats()
        self.assertEqual((st["requested"], st["run"], st["folded"], st["batches"]), (3, 2, 1, 1))
        self.assertEqual(s.pending, 0)

    def test_oversize_flush_is_cut(self):
        s, calls = self.mk(max_batch=4)
        t = [s.submit(*self.req(i, i + 1, i)) for i in range(10)]
        res = s.flush()
        self.assertEqual(calls, [4, 4, 2])
        self.assertEqual(s.stats()["splits"], 2)
        self.assertEqual([int(res[x][1]) for x in t], list(range(10)))

    def test_empty_flush(self):
        s, calls = self.mk()
        self.assertEqual(s.flush(), {})
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
