@echo off
REM Drag a folder onto this file, or double-click to convert the current folder.
REM Converts every .pptx/.ppt under the folder to PDF (see pptx2pdf.py).
setlocal
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%CD%"
python "%~dp0pptx2pdf.py" "%TARGET%"
echo.
pause
