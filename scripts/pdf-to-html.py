#!/usr/bin/env python
# Convierte un PDF (deck/brochure) a un HTML auto-contenido: cada pagina se
# renderiza a PNG y se incrusta como base64. Sin dependencias externas en el
# HTML resultante -> abre igual en cualquier navegador (movil incluido).
import base64
import io
import sys

import fitz  # PyMuPDF
from PIL import Image

def convert(pdf_path, html_path, title, dpi=140, jpeg_quality=82):
    doc = fitz.open(pdf_path)
    imgs = []
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    for page in doc:
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        imgs.append(b64)
    doc.close()

    slides = "\n".join(
        f'    <img class="slide" loading="lazy" alt="Pagina {i+1}" '
        f'src="data:image/jpeg;base64,{b64}">'
        for i, b64 in enumerate(imgs)
    )
    html = f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: #0e0e12; color: #eaeaea;
         font-family: -apple-system, Segoe UI, Roboto, system-ui, sans-serif; }}
  header {{ padding: 20px 16px; text-align: center; }}
  header h1 {{ font-size: 18px; font-weight: 600; margin: 0; letter-spacing: .2px; }}
  main {{ max-width: 920px; margin: 0 auto; padding: 0 12px 48px; }}
  .slide {{ width: 100%; height: auto; display: block; border-radius: 10px;
            margin: 10px 0; box-shadow: 0 6px 24px rgba(0,0,0,.35); }}
  footer {{ text-align: center; padding: 24px 16px; opacity: .6; font-size: 12px; }}
</style>
</head>
<body>
  <header><h1>{title}</h1></header>
  <main>
{slides}
  </main>
  <footer>30X &middot; EstadoX</footer>
</body>
</html>
"""
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    size_mb = len(html.encode("utf-8")) / 1e6
    print(f"OK {html_path}  ({len(imgs)} paginas, {size_mb:.2f} MB)")

if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2], sys.argv[3])
