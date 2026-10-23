# Builds book.json for a book from home out of extract.py's pages.json: the text reflowed into short app pages
# (about 40 words, ending at a paragraph where it can), each with the book's nearest picture.
# Usage: .venv/bin/python -I tools/kindle/assemble.py content/home/<id> <meta.json>
# meta.json: {id, title, bookSeries?, bookNumber?, author, illustrator?, source, names, coverImage, chapters: [titles], drop_caps: {"<capture>": "D"}, fixes: [[old, new]]}
import json, math, re, shutil, sys
from pathlib import Path

root = Path(sys.argv[1])
meta = json.loads(Path(sys.argv[2]).read_text())
pages = json.loads((root / 'pages.json').read_text())
words = {l.split(' ', 1)[0].lower() for l in (Path(__file__).resolve().parents[2] / 'data/cmudict.dict').read_text(errors='ignore').splitlines() if l}

def join_lines(a, b):
  # a line ending in "-" is a word broken across lines if the halves make a word, else a dash
  m = re.search(r'([A-Za-z]+)-$', a)
  if m:
    w = re.match(r'[A-Za-z]+', b)
    if w and (m.group(1) + w.group(0)).lower() in words: return a[:-1] + b
    return a[:-1] + '— ' + b
  return a + ' ' + b

def tidy(t):
  t = re.sub(r'\s+-\s+', ' — ', t)
  t = re.sub(r'(\w)-(\s|$)', r'\1—\2', t)
  t = t.replace('. . .', '…').replace('...', '…').replace('… …', '…')
  for old, new in meta.get('fixes', []): t = t.replace(old, new)
  return re.sub(r'\s+', ' ', t).strip()

# 1. the book as a stream: chapter headings and paragraphs, each with the capture it starts on
items, pictures, chapter, started = [], [], 0, False
for p in pages:
  head = any(l['text'].strip().upper() == 'CHAPTER' for l in p['lines'])
  if head:
    started, chapter = True, chapter + 1
  if not started: continue
  if p['picture']: pictures.append((p['n'], p['picture']))
  if head: items.append({'kind': 'chapter', 'text': meta['chapters'][chapter - 1], 'n': p['n']})
  body = [l for l in p['lines'] if l['body']]
  if not body: continue
  left = min(l['x'] for l in body)
  for i, l in enumerate(body):
    text = l['text']
    if i == 0 and head: text = meta['drop_caps'].get(p['n'], '') + text
    new = l['x'] > left + 25 or (i == 0 and head) or not items or items[-1]['kind'] != 'para'
    # an indent that starts lowercase is text flowing round a picture, not a new paragraph
    if new and items and items[-1]['kind'] == 'para' and text[:1].islower(): new = False
    if new:
      # OCR drops some periods at the end of a paragraph ("she yelled")
      if items and items[-1]['kind'] == 'para' and items[-1]['text'][-1:].isalpha(): items[-1]['text'] += '.'
      items.append({'kind': 'para', 'text': text, 'n': p['n']})
    else:
      items[-1]['text'] = join_lines(items[-1]['text'], text)

# 2. app pages
def sentences(t):
  return [s.strip() for s in re.findall(r'.+?(?:[.!?…]+[”"’]?(?=\s+[“"A-Z])|$)', t) if s.strip()]

# A chapter isn't a page of its own: its title goes on the first page of the chapter (page.chapter).
# Pages are made even, since the reader shows the whole book at one text size (fit: "book"), the size its fullest
# page needs: each chapter is cut into as many pages as it takes to keep them near TARGET characters, at the break
# points (between sentences) that keep the pages closest to the same length, preferring the end of a paragraph.
# No page is over CAP unless one sentence is.
TARGET, CAP, HEAD, MIDPARA = 200, 240, 40, 900   # characters; the chapter title counts as HEAD; a mid-paragraph break costs MIDPARA
def paginate(title, units):   # units: [{text, n, end}] (end: the last sentence of a paragraph)
  size = [len(u['text']) + 1 for u in units]
  total = sum(size) + HEAD
  target = total / math.ceil(total / TARGET)
  best = [0] + [float('inf')] * len(units)   # best[j]: cost of paging units[:j]
  back = [0] * (len(units) + 1)
  for j in range(1, len(units) + 1):
    length = HEAD if title else 0
    for i in range(j - 1, -1, -1):
      length += size[i]
      if length > CAP and i < j - 1: break
      cost = best[i] + (length - target) ** 2 + (0 if units[j - 1]['end'] or j == len(units) else MIDPARA)
      if cost < best[j]: best[j], back[j] = cost, i
  cuts, j = [], len(units)
  while j: cuts.append((back[j], j)); j = back[j]
  out = []
  for k, (i, j) in enumerate(reversed(cuts)):
    out.append({'text': ' '.join(u['text'] for u in units[i:j]), 'n': units[i]['n'], **({'chapter': title} if k == 0 and title else {})})
  return out

chunks = []   # {text, n, chapter?}
title, units = None, []
for it in items + [{'kind': 'chapter', 'text': None, 'n': None}]:
  if it['kind'] == 'chapter':
    if units: chunks += paginate(title, units)
    title, units = it['text'], []
    continue
  ss = sentences(tidy(it['text']))
  units += [{'text': t, 'n': it['n'], 'end': k == len(ss) - 1} for k, t in enumerate(ss)]

# 3. pictures: each page shows the earliest picture not yet shown from its own capture or before, else the last one.
# color.json (if there is one) says which to drop (the second halves of two-page pictures, scraps); the colored
# copy in color/final/ replaces the capture's own, copied up as color-NNN.jpg (picture keys take one slash).
art = json.loads((root / 'color.json').read_text()) if (root / 'color.json').exists() else {}
pictures = [(n, f) for n, f in pictures if n not in art.get('drop', [])]
def colored(f):
  src = root / 'color' / 'final' / f
  if not src.exists(): return f
  shutil.copyfile(src, root / f'color-{f}')
  return f'color-{f}'
pictures = [(n, colored(f)) for n, f in pictures]
shown, last = 0, None
for c in chunks:
  if shown < len(pictures) and pictures[shown][0] <= c['n']:
    last = pictures[shown][1]; shown += 1
  c['image'] = f'{root.name}/{last}' if last else None

book = {
  'id': meta['id'], 'kind': 'book', 'series': 'Books from home', 'number': meta.get('number', 2),
  'title': meta['title'], **{k: meta[k] for k in ('bookSeries', 'bookNumber', 'illustrator') if k in meta},
  'author': meta['author'], 'source': meta['source'],
  'coverImage': meta['coverImage'], 'names': meta['names'], 'fit': 'book',
  'pages': [{k: v for k, v in (('chapter', c.get('chapter')), ('text', c['text']), ('image', c['image'])) if v} for c in chunks],
}
(root / 'book.json').write_text(json.dumps(book, indent=2, ensure_ascii=False) + '\n')
print(f'{len(book["pages"])} pages, {len(pictures)} pictures, {shown} shown; {len(pictures) - shown} never reached')
