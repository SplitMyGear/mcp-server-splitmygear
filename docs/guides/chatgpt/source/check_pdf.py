"""Checks the built vendor guide PDF before it is shared.

Usage: python3 check_pdf.py [../splitt-chatgpt-vendor-guide.pdf] [out_dir]
Needs: pip install pypdf pypdfium2 pillow

1. Every font is embedded (a missing one renders as a fallback face elsewhere).
2. No soft-mask graphics states. Skia writes a blurred box-shadow as a
   luminosity soft mask and Apple PDFKit (Preview, iOS Files) paints its
   bounding box grey (SPLIT-1581, frontend #844), so the guide uses borders
   and solid fills only. Image alpha channels are fine and are not counted.
3. Rasterizes every page to PNG so a person can look at each one.
"""
import os
import sys

import pypdfium2 as pdfium
from pypdf import PdfReader
from pypdf.generic import IndirectObject

src = sys.argv[1] if len(sys.argv) > 1 else '../splitt-chatgpt-vendor-guide.pdf'
out_dir = sys.argv[2] if len(sys.argv) > 2 else 'pages'


def obj(value):
    return value.get_object() if isinstance(value, IndirectObject) else value


def soft_masks(resources):
    count = 0
    for state in (obj(resources.get('/ExtGState')) or {}).values():
        mask = obj(state).get('/SMask')
        if mask is not None and str(mask) != '/None':
            count += 1
    for xobject in (obj(resources.get('/XObject')) or {}).values():
        xobject = obj(xobject)
        if xobject.get('/Subtype') == '/Form':
            count += soft_masks(obj(xobject.get('/Resources')) or {})
    return count


reader = PdfReader(src)
fonts, unembedded, masks = set(), set(), 0
for page in reader.pages:
    resources = obj(page.get('/Resources')) or {}
    masks += soft_masks(resources)
    for font in (obj(resources.get('/Font')) or {}).values():
        font = obj(font)
        name = str(font.get('/BaseFont'))
        fonts.add(name)
        descendants = obj(font.get('/DescendantFonts'))
        descriptor = obj((obj(descendants[0]) if descendants else font).get('/FontDescriptor')) or {}
        if not any(key in descriptor for key in ('/FontFile', '/FontFile2', '/FontFile3')):
            unembedded.add(name)

print(f'{src}: {len(reader.pages)} pages, {os.path.getsize(src) // 1024} KB')
print(f'fonts: {", ".join(sorted(fonts))}')
print(f'unembedded fonts: {len(unembedded)} {sorted(unembedded) if unembedded else ""}')
print(f'soft-mask graphics states: {masks}')

os.makedirs(out_dir, exist_ok=True)
document = pdfium.PdfDocument(src)
for index in range(len(document)):
    path = os.path.join(out_dir, f'page-{index + 1:02d}.png')
    document[index].render(scale=1.5).to_pil().save(path)
print(f'page images: {out_dir}/page-01.png ... page-{len(document):02d}.png')

sys.exit(1 if unembedded or masks else 0)
