#!/usr/bin/env python3
"""Traite assets/logo.png sans dépendance externe :
- logo-t.png : fond blanc rendu transparent, traits noirs conservés ;
- icon-512.png : icône PWA 512×512, fond noir, traits blancs, liseré rouge."""

import struct
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, w, h, idat = 8, 0, 0, b""
    while pos < len(data):
        length, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            w, h, depth, color = struct.unpack(">IIBB", chunk[:10])
            assert depth == 8 and color == 6, "attendu : RGBA 8 bits"
        elif ctype == b"IDAT":
            idat += chunk
        pos += 12 + length

    raw = zlib.decompress(idat)
    stride = w * 4
    px = bytearray(w * h * 4)
    prev = bytearray(stride)

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            a = line[x - 4] if x >= 4 else 0
            b = prev[x]
            c = prev[x - 4] if x >= 4 else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                line[x] = (line[x] + paeth(a, b, c)) & 255
        px[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, px


def write_png(path, w, h, px):
    stride = w * 4
    raw = b"".join(b"\x00" + bytes(px[y * stride:(y + 1) * stride]) for y in range(h))

    def chunk(ctype, payload):
        return (struct.pack(">I", len(payload)) + ctype + payload
                + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF))

    open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


w, h, px = read_png("assets/logo.png")

# 1) Fond blanc → transparent (alpha = intensité du trait), trait noir pur
out = bytearray(len(px))
for i in range(0, len(px), 4):
    lum = (px[i] + px[i + 1] + px[i + 2]) // 3
    alpha = min(255, (255 - lum) * px[i + 3] // 255)
    out[i:i + 4] = bytes((10, 10, 12, alpha))
write_png("assets/logo-t.png", w, h, out)

# 2) Icône 512×512 : fond #0b0b0c, traits blancs, bande rouge en pied
S = 512
icon = bytearray(S * S * 4)
for i in range(0, len(icon), 4):
    icon[i:i + 4] = bytes((11, 11, 12, 255))
for y in range(S - 34, S):
    for x in range(S):
        icon[(y * S + x) * 4:(y * S + x) * 4 + 4] = bytes((255, 45, 32, 255))

# logo redimensionné (plus proche voisin) et centré
target = 400
ox, oy = (S - target) // 2, (S - target - 40) // 2
for ty in range(target):
    sy = ty * h // target
    for tx in range(target):
        sx = tx * w // target
        a = out[(sy * w + sx) * 4 + 3]
        if a > 20:
            di = ((oy + ty) * S + ox + tx) * 4
            # trait blanc sur fond noir, alpha du trait conservé
            r0, g0, b0 = icon[di], icon[di + 1], icon[di + 2]
            icon[di] = (255 * a + r0 * (255 - a)) // 255
            icon[di + 1] = (255 * a + g0 * (255 - a)) // 255
            icon[di + 2] = (255 * a + b0 * (255 - a)) // 255
write_png("assets/icon-512.png", S, S, icon)
print("→ assets/logo-t.png et assets/icon-512.png générés")
