# 临时：停本地后端进程（用完即删）
$p = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($p) { Stop-Process -Id $p -Force; Write-Output "killed $p" }
else { Write-Output 'no listener' }
