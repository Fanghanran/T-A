# start-services.ps1
# 启动项目 Milvus Compose；可选启动本机已有的 Ollama 容器。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $projectRoot 'milvus-compose.yml'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " 启动项目依赖：Milvus + Ollama（如已存在）" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

if (-not (Test-Path $composeFile)) {
    throw "未找到项目 Compose 文件：$composeFile"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw '未找到 docker 命令，请先启动 Docker Desktop 并确认 PATH 配置。'
}

docker info | Out-Null
Write-Host "`n[1/2] 启动项目 Milvus ..." -ForegroundColor Yellow
docker compose -f $composeFile up -d
if ($LASTEXITCODE -ne 0) { throw 'Milvus Compose 启动失败。' }

Write-Host "`n[2/2] 检查 Ollama 容器 ..." -ForegroundColor Yellow
$ollama = docker ps -a --filter 'name=^ollama$' --format '{{.Names}}'
if ($ollama -eq 'ollama') {
    $running = docker ps --filter 'name=^ollama$' --format '{{.Names}}'
    if ($running -ne 'ollama') { docker start ollama | Out-Null }
    Write-Host '  Ollama 已运行' -ForegroundColor Green
} else {
    Write-Host '  未发现名为 ollama 的容器，跳过（按需自行启动）。' -ForegroundColor DarkGray
}

Write-Host "`n等待 Milvus 健康检查 ..." -ForegroundColor Yellow
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:9091/healthz' -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and $response.Content -match 'OK|ok') { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'Milvus 健康检查超时，请运行 docker compose logs milvus-standalone。' }

Write-Host "`n所有项目依赖已启动（数据卷已保留）" -ForegroundColor Green
