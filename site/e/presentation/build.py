#!/usr/bin/env python3
"""Export the presentation as one offline HTML file. No generation or network calls."""
from pathlib import Path
import base64
import json
import mimetypes
import re
from html import escape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = ROOT / "output" / "ephyra-presentation.html"


def build(inline_media=True):
    html = (HERE / "index.html").read_text()
    css = "\n".join((HERE / name).read_text() for name in ("fonts.css", "presentation.css"))
    js = (HERE / "presentation.js").read_text()
    html = re.sub(r'\s*<link rel="stylesheet"[^>]+>', "", html)
    if inline_media:
        media = {}
        for path in sorted((HERE / "media").iterdir()):
            if path.suffix not in {".png", ".webp", ".svg", ".webm", ".mp3", ".woff2"}:
                continue
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            media[path.name] = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()
        for name, uri in media.items():
            html = html.replace(f'"media/{name}"', f'"{uri}"')
            css = css.replace(f'"media/{name}"', f'"{uri}"').replace(f'url(media/{name})', f'url({uri})')
        js = "window.EPHYRA_MEDIA=" + json.dumps(media, separators=(",", ":")) + ";\n" + js
        licenses = "\n\n".join(path.name + "\n\n" + path.read_text() for path in sorted((HERE / "media").iterdir())
            if path.name.endswith("OFL.txt") or path.name == "LOBE-ICONS-LICENSE")
        html = html.replace("</aside>", '<details><summary>Included asset licenses</summary><pre style="white-space:pre-wrap;max-height:300px;overflow:auto;font-size:12px">'
            + escape(licenses) + "</pre></details></aside>")
    html = html.replace("</head>", "<style>" + css + "</style>\n</head>")
    return html.replace('<script src="presentation.js"></script>', "<script>" + js + "</script>")


if __name__ == "__main__":
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(build())
    (OUT.parent / "ephyra-presentation-preview.html").write_text(build(False))
    print(json.dumps({"file": str(OUT), "bytes": OUT.stat().st_size}))
