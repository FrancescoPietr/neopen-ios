# Genera pacchetti "come se arrivassero dalla penna", per confrontare il kit ufficiale (TypeScript) e NeoPenKit (Swift).
import json, random, struct, zlib, sys
random.seed(7)
STX, ETX, DLE = 0xC0, 0xC1, 0x7D

def esc(bs):
    out = []
    for b in bs:
        if b in (STX, ETX, DLE): out += [DLE, b ^ 0x20]
        else: out.append(b)
    return out

def frame(cmd, data, result=0):
    has_result = (cmd >> 4) != 0x6 and cmd not in (0x73, 0x24, 0x32)
    body = [cmd] + ([result] if has_result else []) + list(struct.pack('<H', len(data))) + list(data)
    return [STX] + esc(body) + [ETX]

def so(section, owner): return struct.pack('<I', owner)[:3] + bytes([section])
def s16(s, n): b = s.encode()[:n]; return b + bytes(n - len(b))

def version():
    d = s16('NWP-F51', 16) + s16('1.10', 16) + s16('2.18', 8) + s16('M1+', 16) + struct.pack('<H', 1) + bytes([0x9c,0x7b,0xd2,0xc0,0x7d,0xc1]) + bytes([1]) + struct.pack('<H', 0) + bytes([1, 2])
    return frame(0x81, d)

def settings(locked=0, battery=87):
    d = bytes([locked, 10, 0]) + struct.pack('<Q', 1792000000000) + struct.pack('<H', 20) + struct.pack('<H', 1023) + bytes([12, 1, 1, 0, 0, battery, 1, 0])
    return frame(0x84, d)

def note_list(notes):
    d = struct.pack('<H', len(notes)) + b''.join(so(s, o) + struct.pack('<I', n) for s, o, n in notes)
    return frame(0xA1, d)

def page_list(s, o, n, pages):
    d = so(s, o) + struct.pack('<I', n) + struct.pack('<H', len(pages)) + b''.join(struct.pack('<I', p) for p in pages)
    return frame(0xA2, d)

def offline_resp(strokes, size, failed=False):
    return frame(0xA3, struct.pack('<I', strokes) + struct.pack('<I', size) + bytes([1]), result=1 if failed else 0)

def make_strokes(page, n, t0):
    out = []
    t = t0
    for i in range(n):
        dots = random.randint(3, 40)
        x, y = random.uniform(5, 80), random.uniform(5, 110)
        st = bytearray()
        st += struct.pack('<I', page) + struct.pack('<Q', t) + struct.pack('<Q', t + dots * 12) + bytes([0 if i % 7 else 1]) + struct.pack('<I', 0xFF000000 | random.randint(0, 0xFFFFFF)) + struct.pack('<H', dots)
        for j in range(dots):
            x += random.uniform(-0.6, 0.9); y += random.uniform(-0.5, 0.5)
            xi, yi = int(x), int(y)
            fx, fy = int((x - xi) * 100), int((y - yi) * 100)
            # qualche punto con coordinate "negative" (0xFFFF) come capita davvero
            if random.random() < 0.02: xi = 0xFFFF
            st += bytes([random.randint(5, 15)]) + struct.pack('<H', random.randint(0, 1023)) + struct.pack('<H', xi & 0xFFFF) + struct.pack('<H', yi & 0xFFFF) + bytes([fx, fy, 10, 20]) + struct.pack('<H', 0) + struct.pack('<H', 0) + bytes([0])
        out.append(bytes(st))
        t += dots * 12 + random.randint(100, 3000)
    return out

def offline_packets(s, o, n, page, nstrokes, per_packet, mode):
    strokes = make_strokes(page, nstrokes, 1792370000000 + page * 10000000)
    pkts = []
    groups = [strokes[i:i + per_packet] for i in range(0, len(strokes), per_packet)]
    for idx, g in enumerate(groups):
        raw = b''.join(g)
        if mode == 'zlib9': data, comp = zlib.compress(raw, 9), 1
        elif mode == 'zlib1': data, comp = zlib.compress(raw, 1), 1
        elif mode == 'stored': data, comp = zlib.compress(raw, 0), 1
        else: data, comp = raw, 0
        pos = 0 if idx == 0 else (2 if idx == len(groups) - 1 else 1)
        if len(groups) == 1: pos = 2
        d = struct.pack('<H', idx) + bytes([comp]) + struct.pack('<H', len(raw)) + struct.pack('<H', len(data) if comp else 0) + bytes([pos]) + so(s, o) + struct.pack('<I', n) + struct.pack('<H', len(g)) + data
        pkts.append(frame(0x24, d))
    total = sum(len(x) for x in strokes)
    return strokes, pkts, total

def live_stroke(s, o, n, page, t, new=True, dots=25):
    out = []
    ec = random.randint(0, 200)
    if new: out.append(frame(0x69, bytes([ec]) + struct.pack('<Q', t) + bytes([0]) + struct.pack('<I', 0xFF112233)))
    else: out.append(frame(0x63, bytes([0]) + struct.pack('<Q', t) + bytes([0]) + struct.pack('<I', 0xFF112233)))
    ec += 1
    out.append(frame(0x6B if new else 0x64, (bytes([ec]) if new else b'') + so(s, o) + struct.pack('<I', n) + struct.pack('<I', page)))
    x, y = random.uniform(10, 60), random.uniform(10, 90)
    for j in range(dots):
        ec += 1
        x += random.uniform(0.1, 0.6); y += random.uniform(-0.3, 0.3)
        xi, yi = int(x), int(y)
        d = (bytes([ec & 0xFF]) if new else b'') + bytes([random.randint(5, 14)]) + struct.pack('<H', random.randint(100, 900)) + struct.pack('<H', xi) + struct.pack('<H', yi) + bytes([int((x - xi) * 100), int((y - yi) * 100), 3, 4]) + struct.pack('<H', 0)
        out.append(frame(0x6C if new else 0x65, d))
    ec += 1
    if new: out.append(frame(0x6A, bytes([ec & 0xFF]) + struct.pack('<Q', t + 900) + struct.pack('<H', dots) + bytes(8)))
    else: out.append(frame(0x63, bytes([1]) + struct.pack('<Q', t + 900) + bytes([0]) + struct.pack('<I', 0xFF112233)))
    return out

def chunked(packets):
    """Pacchetti spezzati a caso come le notifiche Bluetooth (anche a metà di un escape)."""
    flat = [b for p in packets for b in p]
    out, i = [], 0
    while i < len(flat):
        n = random.randint(1, 20)
        out.append(bytes(flat[i:i + n]).hex()); i += n
    return out

vectors = []
vectors.append({'name': 'handshake', 'chunks': chunked([version(), settings()])})
vectors.append({'name': 'lists', 'chunks': chunked([note_list([(3, 27, 746), (3, 27, 600), (0, 0xC1C0, 7)]), page_list(3, 27, 746, [5, 6, 7, 8, 9, 0xC0]), page_list(3, 27, 600, [])])})
for mode in ['zlib9', 'zlib1', 'stored', 'plain']:
    for per in [1, 4, 50]:
        st, pk, total = offline_packets(3, 27, 746, 9, 23, per, mode)
        vectors.append({'name': f'offline-{mode}-{per}', 'chunks': chunked([offline_resp(len(st), total)] + pk)})
vectors.append({'name': 'offline-failure', 'chunks': chunked([offline_resp(0, 0)])})
lv = []
for k in range(6): lv += live_stroke(3, 27, 746, 9 + (k // 3), 1792371000000 + k * 5000, new=(k % 2 == 0))
lv.append(frame(0x62, bytes([1])))
vectors.append({'name': 'live', 'chunks': chunked(lv)})
json.dump(vectors, open(sys.argv[1], 'w'))
print(len(vectors), 'vettori')
