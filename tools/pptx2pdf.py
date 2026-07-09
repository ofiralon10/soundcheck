#!/usr/bin/env python3
"""
pptx2pdf.py — batch-convert every PowerPoint (.pptx / .ppt) under a folder to
PDF, next to the original file (same name, .pdf extension).

Use it before the app's "Setlist Files" bulk update: the app can't render
PowerPoint, but it turns PDFs into slide images cleanly. Run this once over
your setlist folder, then run the update in the app.

Usage:
    Double-click this file  -> converts the folder the script sits in.
    python pptx2pdf.py [FOLDER]          # or point it at another folder
    python pptx2pdf.py [FOLDER] --force  # reconvert even if PDF is newer

Conversion backend (auto-detected, in order):
    1. LibreOffice  (soffice --headless)  — no Microsoft Office needed, best
       cross-platform choice.  Install: https://www.libreoffice.org
    2. Microsoft PowerPoint via COM (Windows only, PowerPoint installed).
       Needs:  pip install comtypes

Only one backend is required. LibreOffice is recommended.
"""
import os, sys, glob, shutil, subprocess


def find_soffice():
    candidates = [
        "soffice", "soffice.exe",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice", "/usr/local/bin/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ]
    for c in candidates:
        p = shutil.which(c)
        if p:
            return p
        if os.path.isfile(c):
            return c
    return None


def needs_convert(src, force):
    pdf = os.path.splitext(src)[0] + ".pdf"
    if force or not os.path.exists(pdf):
        return True
    return os.path.getmtime(pdf) < os.path.getmtime(src)


def convert_with_soffice(soffice, files):
    ok = 0
    for f in files:
        outdir = os.path.dirname(os.path.abspath(f))
        try:
            subprocess.run(
                [soffice, "--headless", "--convert-to", "pdf", "--outdir", outdir, f],
                capture_output=True, text=True, timeout=180,
            )
        except Exception as e:
            print("FAIL", f, "-", e)
            continue
        if os.path.exists(os.path.splitext(f)[0] + ".pdf"):
            print("OK  ", f)
            ok += 1
        else:
            print("FAIL", f, "- no PDF produced")
    return ok


def convert_with_powerpoint(files):
    import comtypes.client  # pip install comtypes
    ppt = comtypes.client.CreateObject("PowerPoint.Application")
    ok = 0
    try:
        for f in files:
            src = os.path.abspath(f)
            pdf = os.path.splitext(src)[0] + ".pdf"
            try:
                pres = ppt.Presentations.Open(src, WithWindow=False)
                pres.SaveAs(pdf, 32)  # 32 = ppSaveAsPDF
                pres.Close()
                print("OK  ", f)
                ok += 1
            except Exception as e:
                print("FAIL", f, "-", e)
    finally:
        try:
            ppt.Quit()
        except Exception:
            pass
    return ok


def script_dir():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except Exception:
        return os.getcwd()


def main():
    args = [a for a in sys.argv[1:]]
    force = "--force" in args
    args = [a for a in args if a != "--force"]
    # No folder given (e.g. double-clicked) -> use the folder this script is in.
    root = args[0] if args else script_dir()
    if not os.path.isdir(root):
        print("Not a folder:", root)
        sys.exit(1)

    files = []
    for ext in ("*.pptx", "*.ppt"):
        files += glob.glob(os.path.join(root, "**", ext), recursive=True)
    # ignore Office lock/temp files like ~$foo.pptx
    files = sorted(f for f in files if not os.path.basename(f).startswith("~$"))

    if not files:
        print("No .pptx/.ppt files found under", root)
        return

    todo = [f for f in files if needs_convert(f, force)]
    skipped = len(files) - len(todo)
    print(f"Found {len(files)} PowerPoint file(s) under {root}")
    if skipped:
        print(f"  {skipped} already have an up-to-date PDF (use --force to redo)")
    if not todo:
        print("Nothing to convert.")
        return

    soffice = find_soffice()
    if soffice:
        print("Using LibreOffice:", soffice)
        ok = convert_with_soffice(soffice, todo)
    else:
        print("LibreOffice not found — trying Microsoft PowerPoint (Windows)…")
        try:
            ok = convert_with_powerpoint(todo)
        except Exception as e:
            print("PowerPoint automation unavailable:", e)
            print()
            print("Install one of these, then re-run:")
            print("  * LibreOffice  https://www.libreoffice.org  (recommended)")
            print("  * or, on Windows with PowerPoint:  pip install comtypes")
            sys.exit(2)

    print(f"\nDone. {ok}/{len(todo)} converted.")


if __name__ == "__main__":
    # When double-clicked (no folder argument) keep the window open at the end.
    _interactive = not [a for a in sys.argv[1:] if a != "--force"]
    try:
        main()
    finally:
        if _interactive:
            try:
                input("\nPress Enter to close…")
            except Exception:
                pass
