@echo off
chcp 65001 >nul
title 插件编码工具

echo ========================================
echo   Zoaholic 插件编码工具
echo ========================================
echo.
echo 请选择编码模式:
echo   1. 编码全部插件（自动扫描 plugins/ 目录）
echo   2. 手动选择要编码的插件
echo.
set /p MODE="请输入选项 (1/2): "

setlocal enabledelayedexpansion

if "%MODE%"=="2" goto :MANUAL

REM ========== 模式1: 自动扫描全部 ==========
:AUTO
set "FILES="
for %%f in (plugins\*.py) do (
    set "NAME=%%~nxf"
    if /i not "!NAME!"=="__init__.py" (
        if /i not "!NAME:~0,8!"=="example_" (
            set "FILES=!FILES! plugins\%%~nxf"
        )
    )
)

if "!FILES!"=="" (
    echo.
    echo [错误] plugins/ 目录下没有找到可编码的 .py 文件
    pause
    exit /b 1
)

echo.
echo 将编码以下插件:
for %%f in (!FILES!) do echo   - %%f
echo.
goto :ENCODE

REM ========== 模式2: 手动选择 ==========
:MANUAL
echo.
echo 可用的插件文件:
set IDX=0
for %%f in (plugins\*.py) do (
    set "NAME=%%~nxf"
    if /i not "!NAME!"=="__init__.py" (
        if /i not "!NAME:~0,8!"=="example_" (
            set /a IDX+=1
            set "PLUGIN_!IDX!=plugins\%%~nxf"
            echo   !IDX!. %%~nxf
        )
    )
)

if !IDX!==0 (
    echo.
    echo [错误] plugins/ 目录下没有找到可编码的 .py 文件
    pause
    exit /b 1
)

echo.
echo 请输入要编码的插件编号（用空格或逗号分隔，如: 1 3 5 或 1,3,5）
echo 输入 a 编码全部
set /p SELECTION="选择: "

if /i "%SELECTION%"=="a" (
    set "FILES="
    for /L %%i in (1,1,!IDX!) do (
        set "FILES=!FILES! !PLUGIN_%%i!"
    )
    goto :SHOW_SELECTED
)

REM 解析用户输入（支持空格和逗号分隔）
set "SELECTION=!SELECTION:,= !"
set "FILES="
for %%n in (!SELECTION!) do (
    set "F=!PLUGIN_%%n!"
    if defined F (
        set "FILES=!FILES! !F!"
    ) else (
        echo [警告] 编号 %%n 无效，已跳过
    )
)

:SHOW_SELECTED
if "!FILES!"=="" (
    echo.
    echo [错误] 没有选择任何插件
    pause
    exit /b 1
)

echo.
echo 将编码以下插件:
for %%f in (!FILES!) do echo   - %%f
echo.

:ENCODE
python restore_plugins.py --encode !FILES!

echo.
echo ========================================
echo 请将上方输出的 JSON 值复制到 Render 的
echo CUSTOM_PLUGINS_JSON 环境变量中
echo ========================================
pause
