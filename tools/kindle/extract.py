# Turns Kindle Cloud Reader window captures into page text and picture crops.
# Each capture raw/NNN.png (2560 px wide, retina) becomes pages.json entries {n, lines, picture} and,
# when the page has a drawing, NNN.jpg: the drawing with the text painted out.
# Usage: .venv/bin/python -I tools/kindle/extract.py content/home/<id> [skip,captures]
import json, subprocess, sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage

root = Path(sys.argv[1])
ocr = Path(__file__).resolve().parents[2] / '.build' / 'ocr'
TOP = 232          # below the browser toolbar
INK = 225          # darker than this is ink
FOOT = 1240        # where the page number band starts
# pictures sit next to book.json: a picture key is <book>/<file> (one slash, as /api/pictures expects)
# captures whose crop isn't a picture (the end of a letter, a drop cap)
skip = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else set()

def page_box(g):
  ink = g < 250
  rows, cols = np.where(ink.any(1))[0], np.where(ink.any(0))[0]
  if not len(rows): return None
  return cols[0], rows[0], cols[-1] + 1, rows[-1] + 1

def free_band(h, boxes, y0, y1):
  # the tallest run of rows in [y0, y1) that no text line touches
  busy = np.zeros(h, bool)
  for b in boxes: busy[max(b[1] - 10, 0):b[1] + b[3] + 10] = True
  best, start = (0, 0), None
  for y in range(y0, y1 + 1):
    free = y < y1 and not busy[y]
    if free and start is None: start = y
    if not free and start is not None:
      if y - start > best[1] - best[0]: best = (start, y)
      start = None
  return best

out = []
for f in sorted((root / 'raw').glob('[0-9][0-9][0-9].png')):
  img = Image.open(f).convert('RGB')
  img = img.crop((0, TOP, img.width, img.height))
  g = np.asarray(img.convert('L'))
  lines = [l for l in json.loads(subprocess.check_output([str(ocr), str(f)])) if l['y'] > TOP]
  for l in lines: l['y'] -= TOP
  lines.sort(key=lambda l: (l['y'], l['x']))
  # body text: lowercase and text-sized; a lone word only in the text column (stray OCR inside drawings,
  # "colonis", sits out to the side); titles are capitals
  lines = [dict(l, body=bool(any(c.islower() for c in l['text']) and 18 < l['h'] < 75
           and (len(l['text'].split()) > 1 or 880 <= l['x'] < 1450))) for l in lines]
  entry = {'n': f.stem, 'lines': [{k: l[k] for k in ('text', 'x', 'y', 'w', 'h', 'body')} for l in lines], 'picture': None}
  box = page_box(g)
  if box:
    boxes = [(l['x'] - 6, l['y'] - 6, l['w'] + 12, l['h'] + 12) for l in lines if l['body']]
    paint = np.zeros(g.shape, bool)
    for x, y, w, h in boxes: paint[max(y, 0):y + h, max(x, 0):x + w] = True
    ink = (g < INK) & ~paint
    blobs, n = ndimage.label(ndimage.binary_dilation(ink, iterations=12))
    sizes = ndimage.sum(ink, blobs, range(1, n + 1))
    keep = [i + 1 for i, s in enumerate(sizes) if s > 4000]
    if keep:
      m = np.isin(blobs, keep) & ink
      ys, xs = np.where(m)
      x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
      text_in = sum(max(0, min(x + w, x1) - max(x, x0)) * max(0, min(y + h, y1) - max(y, y0)) for x, y, w, h in boxes)
      if text_in > 0.08 * (x1 - x0) * (y1 - y0):
        # text sits on the drawing (a tinted page, a picture with words in it): keep the largest text-free band
        b0, b1 = free_band(g.shape[0], boxes, y0, y1)
        # a chapter title ends the picture: below it is only the drop cap's dragon
        heads = [l['y'] + l['h'] for l in lines if not l['body'] and l['h'] > 60 and b0 <= l['y'] < b1]
        if heads: b1 = min(b1, max(heads) + 30)
        if b1 - b0 > 150:
          ys2, xs2 = np.where(m[b0:b1])
          x0, y0, x1, y1 = xs2.min(), b0 + ys2.min(), xs2.max() + 1, b0 + ys2.max() + 1
        else: x0 = None
      # the page number sits at the foot of every page (OCR misses some): pictures stop above it
      if x0 is not None: y1 = min(y1, FOOT)
      if x0 is not None and (x1 - x0) * (y1 - y0) > 120_000 and f.stem not in skip:
        a = np.asarray(img).copy()
        # paint text out with the page around it (white, or dark on a dark page)
        for x, y, w, h in boxes:
          x, y = max(x, 0), max(y, 0)
          ring = np.concatenate([a[max(y - 8, 0):y, x:x + w].reshape(-1, 3), a[y + h:y + h + 8, x:x + w].reshape(-1, 3)])
          a[y:y + h, x:x + w] = np.median(ring, 0) if len(ring) else 255
        Image.fromarray(a).crop((x0, y0, x1, y1)).save(root / f'{f.stem}.jpg', quality=88)
        entry['picture'] = f'{f.stem}.jpg'
        entry['box'] = [int(v) for v in (x0, y0, x1, y1)]
  out.append(entry)
  print(f.stem, len(lines), 'lines', entry['picture'] or '-', entry.get('box', ''), flush=True)
(root / 'pages.json').write_text(json.dumps(out, indent=1))
