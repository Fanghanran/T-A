# stop-services.ps1
# 停止项目 Milvus Compose 与本机已有的 Ollama 容器；不删除卷、不关闭 Docker/WSL。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $projectRoot 'milvus-compose.yml'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " 停止项目依赖：Milvus + Ollama（如存在）" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

if (Get-Command docker -ErrorAction SilentlyContinue) {
    if (Test-Path $composeFile) {
        Write-Host "`n[1/2] 停止项目 Milvus ..." -ForegroundColor Yellow
        docker compose -f $composeFile down
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Milvus Compose 停止失败。' }
    } else {
        Write-Warning "未找到项目 Compose 文件：$composeFile"
    }

    Write-Host "`n[2/2] 停止 Ollama 容器（不删除） ..." -ForegroundColor Yellow
    $running = docker ps --filter 'name=^ollama$' --format '{{.Names}}'
    if ($running -eq 'ollama') {
        docker stop -t 15 ollama | Out-Null
        Write-Host '  Ollama 已停止，容器与数据已保留。' -ForegroundColor Green
    } else {
        Write-Host '  Ollama 未运行，跳过。' -ForegroundColor DarkGray
    }
} else {
    Write-Warning '未找到 docker 命令，未执行任何停止操作。'
}

Write-Host "`n项目依赖已停止；Docker、WSL 和数据卷均未修改。" -ForegroundColor Green
