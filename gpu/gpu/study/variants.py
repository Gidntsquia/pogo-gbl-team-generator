"""Round 8 study variants (plans round 8 R6/R7): one function per name in kernel3v3.STUDY_VARIANTS, each returning that
fork's variant module (gpu/gpu/study/<name>/variant.py, with apply(K)). Imported only when POGO_GPU_STUDY is set."""


def prof():
    from .prof import variant
    return variant


def width():
    from .width import variant
    return variant


def stack():
    from .stack import variant
    return variant


def pool():
    from .pool import variant
    return variant


def split():
    from .split import variant
    return variant


def lockstep():
    from .lockstep import variant
    return variant


def streams():
    from .streams import variant
    return variant


def cpushare():
    from .cpushare import variant
    return variant


def queue():
    from .queue import variant
    return variant


def early():
    from .early import variant
    return variant


def occ():
    from .occ import variant
    return variant


def tail():
    from .tail import variant
    return variant


def certain():
    from .tail import certain as c
    return c
