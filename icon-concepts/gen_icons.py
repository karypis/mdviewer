#!/usr/bin/env python3
import os, sys, json, base64, urllib.request, concurrent.futures

KEY = os.environ["OPENAI_API_KEY"]
OUT = os.path.dirname(os.path.abspath(__file__))

COMMON = ("Design a modern macOS application icon, rendered as a rounded-square "
          "(squircle) app tile that fills the frame, with soft depth and a subtle "
          "gradient. Crisp, flat, premium look like Apple's own app icons. "
          "Centered single motif, generous padding, no real words or paragraphs of "
          "text, no UI chrome, no drop-shadow outside the tile. ")

CONCEPTS = {
  "c1_doc_md": COMMON + (
    "Motif: a clean document page with a bold Markdown mark on it. The mark is a "
    "white rounded 'M' next to a downward chevron arrow. Deep charcoal-to-slate "
    "background tile (#0f0f0f to #242424) with a bright blue accent (#4a9eff) on "
    "the document. Dark, sleek, developer-tool aesthetic."),
  "c2_comment": COMMON + (
    "Motif: a document page with horizontal text lines, one line highlighted, and "
    "a rounded speech/comment bubble overlapping the top-right corner. Background "
    "tile a deep blue gradient (#1a3a5c to #0f0f0f); document light; the comment "
    "bubble in warm amber (#e0a030). Conveys 'read and comment on Markdown'."),
  "c3_monogram": COMMON + (
    "Motif: a minimalist monogram of a capital 'M' merged with a downward arrow, "
    "centered, thick rounded strokes, white on a vivid blue squircle with a smooth "
    "top-left-to-bottom-right gradient (#4a9eff to #1a3a5c). Very clean and iconic, "
    "like the official Markdown logo reimagined."),
  "c4_app": COMMON + (
    "Motif: a single document page, dark theme, showing two bold heading bars and a "
    "small margin comment card clipped to its right edge with a colored left border. "
    "Charcoal tile (#0f0f0f) with blue (#4a9eff) headings and one amber (#e0a030) "
    "comment accent. Mirrors a dark Markdown editor with margin notes."),
}

def gen(name, prompt):
    body = json.dumps({
        "model": "gpt-image-1",
        "prompt": prompt,
        "size": "1024x1024",
        "quality": "high",
        "n": 1,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations", data=body,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
        b64 = data["data"][0]["b64_json"]
        path = os.path.join(OUT, name + ".png")
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        return name, "OK", path
    except urllib.error.HTTPError as e:
        return name, "HTTP %s: %s" % (e.code, e.read().decode()[:300]), None
    except Exception as e:
        return name, "ERR: %r" % e, None

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
    futs = [ex.submit(gen, n, p) for n, p in CONCEPTS.items()]
    for f in concurrent.futures.as_completed(futs):
        name, status, path = f.result()
        print(f"{name}: {status}{(' -> ' + path) if path else ''}", flush=True)
