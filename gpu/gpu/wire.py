"""Binary wire format between gpu/client.mjs (or any caller) and gpu/sidecar.py.

Every message, both directions, is a 24-byte little-endian header followed by a raw payload:

    u32 magic 0x31504247 ("GBP1")  | u32 op / status | u32 n | u32 arg | u32 a | u32 b | payload ...

Requests (op):
    1 PING     no payload                       -> status 0
    2 STATIC   n = byte length; payload = UTF-8 JSON list of mon descriptors (gpu/describe.mjs rows), sent once
    3 BATCH3   arg = 0 float32 build / 1 double build; payload = idx i32[n*6] | dyn f64[n*6*D_N] | seeds u32[n]
    4 BATCH1   arg as above; payload = idx i32[n*2] | dyn f64[n*2*D_N]
    5 (unused; a file-pair transport was tried and dropped)
    6 STREAMS  arg = number of CUDA streams for later BATCH3 requests (default 1)
    9 QUIT
Responses: op = status (0 ok, 1 error: payload is the UTF-8 message), n = rows, arg = kernel-side microseconds,
    a = columns per row, b = launch pieces (> 1 means the batch was split), payload = i32[n*a] row-major.
D_N = 17 doubles per mon (pack.py); the output rows are kernel3v3.B_OUT = 24 / kernel1v1.OUT_N = 18 int32 columns.
"""
import struct

MAGIC = 0x31504247
HDR = struct.Struct("<6I")
PING, STATIC, BATCH3, BATCH1, FILE, STREAMS, QUIT = 1, 2, 3, 4, 5, 6, 9


def read_exact(f, k):
    """Read exactly k bytes from a binary stream; None on clean EOF at a message boundary."""
    buf = bytearray()
    while len(buf) < k:
        chunk = f.read(k - len(buf))
        if not chunk:
            if not buf:
                return None
            raise EOFError("stream ended mid-message")
        buf += chunk
    return bytes(buf)


def pack_header(op, n=0, arg=0, a=0, b=0):
    return HDR.pack(MAGIC, op, n, arg, a, b)


def unpack_header(raw):
    magic, op, n, arg, a, b = HDR.unpack(raw)
    if magic != MAGIC:
        raise ValueError(f"bad magic 0x{magic:08x}")
    return op, n, arg, a, b


def request_payload_size(op, n, arg):
    from .pack import D_N
    if op == BATCH3:
        return n * 6 * 4 + n * 6 * D_N * 8 + n * 4
    if op == BATCH1:
        return n * 2 * 4 + n * 2 * D_N * 8
    if op == STATIC:
        return n
    return 0
