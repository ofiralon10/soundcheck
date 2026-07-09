# tools/pptx2pdf — PowerPoint → PDF batch converter

The app's **Setlist Files** bulk update can't render PowerPoint, but it turns
**PDFs** into slide images cleanly. Run this once over your setlist folder to
convert every `.pptx`/`.ppt` to a PDF sitting next to it, then run the update
in the app.

## What you need (one of these)

- **LibreOffice** (recommended, no Microsoft Office required) —
  <https://www.libreoffice.org>. The script finds `soffice` automatically.
- **or** Microsoft PowerPoint on Windows + `pip install comtypes`.

Plus **Python 3** (already on most machines; <https://www.python.org>).

## Run it

```
python pptx2pdf.py "C:\path\to\Setlist Folder"
```

Or on Windows, **drag your folder onto `pptx2pdf.bat`** (or double-click it to
convert the folder it's in).

- Recurses into every subfolder (one per song).
- Writes `SongName.pdf` next to each `SongName.pptx`.
- Skips files that already have an up-to-date PDF. Add `--force` to redo them.
- Ignores Office lock files (`~$*.pptx`).

## Then, in the app

Open **Setlist → Setlist Files**, pick the same folder. PDFs are converted to
tall slide JPEGs and filed by their `[Tag]` prefix as usual.
