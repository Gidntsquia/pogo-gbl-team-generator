"""Round 9 study variant "certain" (POGO_GPU_STUDY=tail,certain): with "tail", the host also feeds the battles of teams certain
to survive the cut into the running launch (peek / feed in variant.py). The Node executor drives it; this module only checks
that "tail" is on too."""


def apply(K):
    if "tail" not in K.STUDY:
        raise ValueError("POGO_GPU_STUDY: 'certain' needs 'tail' (use POGO_GPU_STUDY=tail,certain)")
    K.TAIL_CERTAIN = True
