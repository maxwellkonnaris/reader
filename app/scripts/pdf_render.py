#!/usr/bin/env python3
"""
Small PyMuPDF helper for scripts/textbook-formula-check.mjs. Two modes,
mirroring research/15-formula-recognition.md section 2's own methodology
(render pages at 200dpi for layout detection, then re-render just the
detected formula box from the PDF at 300dpi -- cropping the 200dpi raster
instead would throw away resolution the recogniser wants):

  page-full <pdf> <page_num_0based> <dpi> <outfile.png>
    Render a whole page to PNG at the given DPI.

  page-clip <pdf> <page_num_0based> <x0> <y0> <x1> <y1> <dpi> <outfile.png>
    Render just the given box (in PDF points, PDF's own coordinate space)
    to PNG at the given DPI.
"""
import sys

try:
    import pymupdf as fitz  # the "fitz" import name is deprecated upstream
except ImportError:
    try:
        import fitz  # PyMuPDF, older versions
    except ImportError:
        print("PyMuPDF not installed. Run: pip install --user pymupdf", file=sys.stderr)
        sys.exit(1)


def page_full(pdf_path, page_num, dpi, out_path):
    doc = fitz.open(pdf_path)
    page = doc[page_num]
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat)
    pix.save(out_path)
    print(f"{pix.width} {pix.height}")  # so the caller knows the raster size


def page_clip(pdf_path, page_num, x0, y0, x1, y1, dpi, out_path):
    doc = fitz.open(pdf_path)
    page = doc[page_num]
    rect = fitz.Rect(x0, y0, x1, y1)
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat, clip=rect)
    pix.save(out_path)
    print(f"{pix.width} {pix.height}")


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "page-full":
        _, _, pdf_path, page_num, dpi, out_path = sys.argv
        page_full(pdf_path, int(page_num), float(dpi), out_path)
    elif mode == "page-clip":
        _, _, pdf_path, page_num, x0, y0, x1, y1, dpi, out_path = sys.argv
        page_clip(pdf_path, int(page_num), float(x0), float(y0), float(x1), float(y1), float(dpi), out_path)
    else:
        print(f"unknown mode: {mode}", file=sys.stderr)
        sys.exit(1)
