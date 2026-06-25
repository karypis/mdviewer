#!/usr/bin/env python3
"""Turn the chosen concept PNG into a clean macOS .iconset.

The model renders the blue squircle as opaque and the 'M-down-arrow' monogram as
a TRANSPARENT cutout over a white page, so the monogram only looks white. We:
  1. detect the tile = opaque AND not-near-white (the blue/navy gradient),
  2. fill the enclosed monogram holes so the tile is solid,
  3. flatten the cutout onto white so the monogram renders white,
  4. crop to the tile, square it, inset to the macOS content size, emit sizes.
The squircle's own shape provides the rounded corners (transparent outside).
"""
import os, sys, numpy as np
from collections import deque
from PIL import Image, ImageFilter

SRC = sys.argv[1]
OUT = os.path.dirname(os.path.abspath(__file__))
MASTER, INNER = 1024, 824

src = Image.open(SRC).convert("RGBA")
arr = np.asarray(src).astype(np.float32)
alpha = arr[:, :, 3] / 255.0
rgb = arr[:, :, :3]

# The shape lives in the alpha channel: opaque squircle, transparent monogram
# holes AND transparent exterior. Mark the exterior by a border-seeded BFS over
# the transparent pixels; the squircle silhouette is everything not exterior.
H, W = alpha.shape
free = alpha <= 0.5                                    # transparent pixels
visited = np.zeros((H, W), dtype=bool)
dq = deque()
for x in range(W):
    for y in (0, H - 1):
        if free[y, x] and not visited[y, x]:
            visited[y, x] = True; dq.append((y, x))
for y in range(H):
    for x in (0, W - 1):
        if free[y, x] and not visited[y, x]:
            visited[y, x] = True; dq.append((y, x))
while dq:
    y, x = dq.popleft()
    for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
        if 0 <= ny < H and 0 <= nx < W and free[ny, nx] and not visited[ny, nx]:
            visited[ny, nx] = True; dq.append((ny, nx))
filled = ~visited                                      # squircle = opaque tile + holes
fa = np.asarray(Image.fromarray((filled * 255).astype("uint8"), "L")
                .filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) / 255.0

white = np.full_like(rgb, 255.0)
flat = rgb * alpha[..., None] + white * (1 - alpha[..., None])  # monogram -> white
out = np.dstack([flat, fa * 255.0]).astype(np.uint8)
img = Image.fromarray(out, "RGBA")

ys, xs = np.where(filled)
crop = img.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
w, h = crop.size
side = max(w, h)
sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sq.alpha_composite(crop, ((side - w) // 2, (side - h) // 2))

canvas = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
off = (MASTER - INNER) // 2
canvas.alpha_composite(sq.resize((INNER, INNER), Image.LANCZOS), (off, off))
canvas.save(os.path.join(OUT, "icon_master_1024.png"))

iconset = os.path.join(OUT, "mdviewer.iconset")
os.makedirs(iconset, exist_ok=True)
for sz, name in [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]:
    canvas.resize((sz, sz), Image.LANCZOS).save(os.path.join(iconset, name))
print("crop bbox:", (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())), "from", src.size)
print("wrote", iconset)
