@echo off
chcp 65001 >nul
setlocal
rem Ten nguoi dung Windows co dau (vd Nguyen co dau): Python phai in duong dan bang UTF-8.
set "PYTHONUTF8=1"
cd /d "%~dp0"
title GOHA Suno Helper - Cai dat

echo.
echo  ==============================================
echo    GOHA Suno Helper - cai dat cau noi (1 lan)
echo  ==============================================
echo.

rem Chon Python 3.10+ ban thuong (khong lay ban free-threaded "t": thu vien cau noi chua co ban cho no).
rem Uu tien ban on dinh, roi moi den 3.14 va "python" tren PATH.
set "PY="
set "CHECK=import sys, sysconfig; assert sys.version_info >= (3, 10) and not sysconfig.get_config_var('Py_GIL_DISABLED'); print(sys.executable)"
for %%V in (3.13 3.12 3.11 3.10 3.14) do if not defined PY for /f "usebackq delims=" %%P in (`py -%%V -c "%CHECK%" 2^>nul`) do set "PY=%%P"
if not defined PY for /f "usebackq delims=" %%P in (`python -c "%CHECK%" 2^>nul`) do set "PY=%%P"
if not defined PY (
  echo  [!] Chua thay Python 3.10 tro len tren may.
  echo      Tai Python tai https://www.python.org/downloads/ va nho tick "Add python.exe to PATH",
  echo      cai xong thi chay lai file CAI-DAT.bat nay.
  start "" "https://www.python.org/downloads/"
  pause
  exit /b 1
)
echo  [1/3] Python: "%PY%"

echo  [2/3] Cai thu vien cho cau noi (mcp, websockets, PyYAML)...
"%PY%" -m pip install --disable-pip-version-check --quiet -r "bridge\requirements.txt"
if errorlevel 1 (
  echo  [!] Cai thu vien that bai. Xem dong bao loi o tren, kiem tra mang roi chay lai CAI-DAT.bat.
  pause
  exit /b 1
)

echo  [3/3] Ghi duong dan cau noi cho extension...
"%PY%" "bridge\cai_dat.py"
if errorlevel 1 (
  pause
  exit /b 1
)

explorer "%~dp0extension"
pause
