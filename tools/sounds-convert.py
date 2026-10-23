# Turns a set of recorded phonics sounds (and their example words) into another voice, keeping how each sound is said.
# The point: given one good human recording of the sheet, every AI word voice can have phonics sounds to match.
#
# Why not have the AI voice say the sounds? Text-to-speech can't (Oct 23): Aura took spellings like "sss" (Oct 7), Azure
# took IPA through <phoneme>, and both failed on single sounds: voiced consonants lose their voice without a vowel (v
# came out as f, z as s, b as p) and stops click. Voice conversion (Seed-VC) works on ~20 ms slices of a real recording,
# so it never has to invent a lone sound, only re-voice one.
#
# How: the sounds and words are joined into one file with 0.6 s gaps, converted in one go against a reference of the
# target voice (~20 s of it reading), and cut back at the same offsets (the output keeps the input's timing exactly).
#
# Setup, once (Python 3.12; ~2 GB of models download on the first run):
#   git clone --depth 1 https://github.com/Plachtaa/seed-vc.git .cache/seed-vc
#   python3.12 -m venv .cache/vc-venv && .cache/vc-venv/bin/pip install torch==2.4.0 torchaudio==2.4.0 scipy==1.13.1 \
#     librosa==0.10.2 "huggingface-hub>=0.28.1,<1" munch==4.0.0 einops==0.8.0 descript-audio-codec==1.0.0 \
#     transformers==4.46.3 soundfile==0.12.1 numpy==1.26.4 pyyaml hydra-core==1.3.2 accelerate
#   torch 2.4 has no autocast on Apple's GPU: in .cache/seed-vc/inference.py, make the `with torch.autocast(...)` line
#   `with (torch.autocast(device_type=device.type, dtype=torch.float16) if fp16 else __import__("contextlib").nullcontext()):`
#
# Usage: .cache/vc-venv/bin/python -I tools/sounds-convert.py <from who> <reference.wav> <to who> [cfg rate] [steps]
#   e.g. ... eli .cache/vc-ref/luna.wav luna-vc   reads content/sounds/recorded/eli/, writes content/sounds/recorded/luna-vc/
# A reference for an Aura voice: have it read a few sentences through Workers AI (@cf/deepgram/aura-2-en, speaker luna).
# Then listen, and upload with tools/sounds-upload.mjs <to who>; RECORDED in app.js picks whose sounds the app plays.
#
# First try (Eli -> Luna, cfg 0.7, 30 steps, Oct 23): timing exact, 8 minutes for 113 s on the Mac; Eli: "she sounds
# extremely constipated" - held sounds came out strained. Untried: lower cfg rate (0.3-0.5), 50-100 steps, the v2 model,
# a softer recording. Parked there.
import json, os, subprocess, sys
from pathlib import Path
import numpy as np, soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / '.cache/seed-vc'
SR = 22050
SHEET = [['s','sun'],['m','map'],['f','fan'],['n','net'],['l','leg'],['r','rat'],['v','van'],['z','zip'],['sh','ship'],['th','thin'],['dh','this'],['ng','ring'],
  ['t','tap'],['p','pan'],['k','cat'],['b','bat'],['d','dog'],['g','got'],['h','hat'],['j','jam'],['w','wet'],['y','yes'],['ch','chip'],['x','box'],['qu','queen'],
  ['a','ant'],['e','egg'],['i','ink'],['o','on'],['u','up'],['oo-short','book'],
  ['ai','rain'],['ee','see'],['igh','night'],['oa','boat'],['oo','moon'],['ar','car'],['or','fork'],['ur','fur'],['ow','cow'],['oi','coin'],['ear','near'],['air','hair'],['ure','sure'],['ue','cue']]  # as in sounds-record.mjs

src_who, ref, dst_who = sys.argv[1:4]
cfg = sys.argv[4] if len(sys.argv) > 4 else '0.7'
steps = sys.argv[5] if len(sys.argv) > 5 else '30'
src_dir, dst_dir = ROOT / 'content/sounds/recorded' / src_who, ROOT / 'content/sounds/recorded' / dst_who
work = ROOT / '.cache/vc-work'
work.mkdir(parents=True, exist_ok=True)

def load(p):
  return np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', str(p), '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout, np.float32)

# 1. one file: each sound, then its word, 0.6 s apart
gap = np.zeros(int(0.6 * SR), np.float32)
parts, index, t = [gap], [], len(gap)
for sid, word in SHEET:
  for out, path in ((f'{sid}.mp3', src_dir / f'{sid}.mp3'), (f'words/{word}.mp3', src_dir / 'words' / f'{word}.mp3')):
    if not path.exists(): continue
    x = load(path)
    index.append([out, t, t + len(x)]); parts += [x, gap]; t += len(x) + len(gap)
sf.write(work / 'source.wav', np.concatenate(parts), SR)
print(f'{len(index)} clips, {t / SR:.0f} s: converting')

# 2. convert
for f in work.glob('vc_*.wav'): f.unlink()
subprocess.run([sys.executable, 'inference.py', '--source', str(work / 'source.wav'), '--target', str(Path(ref).resolve()), '--output', str(work),
  '--diffusion-steps', steps, '--length-adjust', '1.0', '--inference-cfg-rate', cfg, '--fp16', 'False'],
  cwd=SEED, check=True, env={**os.environ, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'})
y, sr = sf.read(next(work.glob('vc_*.wav')))

# 3. cut back at the same offsets (a little either side, 8 ms fades)
k = sr / SR
(dst_dir / 'words').mkdir(parents=True, exist_ok=True)
for out, a, b in index:
  seg = y[max(0, int(a * k) - int(0.03 * sr)):int(b * k) + int(0.06 * sr)].copy()
  f = int(0.008 * sr); seg[:f] *= np.linspace(0, 1, f); seg[-f:] *= np.linspace(1, 0, f)
  sf.write(work / 'seg.wav', seg, sr)
  subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(work / 'seg.wav'), '-b:a', '96k', str(dst_dir / out)], check=True)
print(f'wrote {len(index)} clips to {dst_dir.relative_to(ROOT)}')
