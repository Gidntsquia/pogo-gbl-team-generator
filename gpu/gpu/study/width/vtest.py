"""Smoke test of the width variant: two launches of one dumped batch through K.run_3v3_slice with no calibration file
(first one calibrates, second one loads the pick), rows compared with the production kernel at G=1."""
import os, sys, glob
import numpy as np
from gpu import kernel3v3 as K  # POGO_GPU_STUDY=width applies the variant
from gpu.study.width import calib as C
d = sys.argv[1]; k = int(sys.argv[2])
f, n = C.batch_sizes(d)[k]
st = C.static_of(d); sl = C.load_one(f, n)
o1, _ = K.run_3v3_slice(st, *sl)
o2, _ = K.run_3v3_slice(st, *sl)
o0, _ = K.slice_collect(K.slice_launch(st, *sl, width=1))
print("rows identical:", np.array_equal(o1[:, :20], o0[:, :20]) and np.array_equal(o2[:, :20], o0[:, :20]), "n", n)
