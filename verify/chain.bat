@echo off
REM 五层哈希链的快捷入口（等价于 python verify/chain.py ...）
REM  双击          -> 校验五层
REM  命令行传参    -> chain.bat sync / chain.bat watch / chain.bat release
setlocal
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0chain.py" %*
) else (
  py -3 "%~dp0chain.py" %*
)
if "%~1"=="" pause
