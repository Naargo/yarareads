#!/bin/sh
# The chapter 1 page-through video (silent: Pinterest autoplays muted). Needs ffmpeg and the pins from make.mjs.
set -e
cd "$(dirname "$0")"
F=$(mktemp -d)
node video-frames.mjs "$F"
python3 - "$F" <<'PY'
import subprocess, sys
S = sys.argv[1]
items = [('pins/11-book-1.jpg', 3)] + [(f'{S}/{i:02d}.png', 3.2 if i != 2 else 2.6) for i in range(1, 9)] + [('pins/04-tap-a-word.jpg', 3.5)]
F = 0.5
args = ['ffmpeg', '-y', '-loglevel', 'error']
for f, d in items: args += ['-loop', '1', '-t', str(d + F), '-i', f]
fl = [f'[{i}:v]scale=1000:1500:force_original_aspect_ratio=decrease,pad=1000:1500:(ow-iw)/2:(oh-ih)/2:color=0xfbf5ea,setsar=1,fps=30,format=yuv420p[v{i}]' for i in range(len(items))]
prev, off = 'v0', 0
for i in range(1, len(items)):
    off += items[i - 1][1]
    fl.append(f'[{prev}][v{i}]xfade=transition=fade:duration={F}:offset={off:.2f}[x{i}]'); prev = f'x{i}'
args += ['-filter_complex', ';'.join(fl), '-map', f'[{prev}]', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', 'pins/20-video.mp4']
subprocess.run(args, check=True)
PY
rm -r "$F"
