#Requires -Version 5.1
<#
.SYNOPSIS
    Sincroniza este repo con TheNetsky/Microsoft-Rewards-Script (rama v4)
    sin perder las modificaciones locales (Scheduler, RunSummary, etc.).

.DESCRIPTION
    Flujo:
      1. fetch de upstream y listado de commits pendientes
      2. merge de upstream/v4 en una rama sync/upstream-YYYYMMDD
      3. npm install + build + tests
      4. si todo pasa, fast-forward/merge a main y borrado de la rama sync
    Si hay conflictos o fallan los tests, la rama sync queda creada para
    resolverlos a mano; el script imprime los pasos restantes.

.EXAMPLE
    .\scripts\sync-upstream.ps1 -DryRun   # solo muestra qué hay nuevo
    .\scripts\sync-upstream.ps1           # sincroniza de verdad
#>
param(
    [switch]$DryRun
)

$UpstreamUrl = 'https://github.com/TheNetsky/Microsoft-Rewards-Script.git'
$UpstreamRef = 'upstream/v4'
$MainBranch  = 'main'

function Fail([string]$msg, [int]$code = 1) {
    Write-Host "[ERROR] $msg" -ForegroundColor Red
    exit $code
}

$root = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { Fail 'Esto no es un repositorio git.' }
Set-Location $root

if (git status --porcelain --untracked-files=no) {
    Fail 'Working tree con cambios sin commitear. Haz commit o stash antes de sincronizar.'
}

$current = git rev-parse --abbrev-ref HEAD
if ($current -ne $MainBranch) { Fail "Debes estar en '$MainBranch' (estás en '$current')." }

if ((git remote) -notcontains 'upstream') {
    git remote add upstream $UpstreamUrl
    Write-Host "[INFO] Remote 'upstream' añadido: $UpstreamUrl"
}

Write-Host '[INFO] Descargando upstream...'
git fetch upstream --quiet
if ($LASTEXITCODE -ne 0) { Fail 'git fetch upstream falló (¿sin red?).' }

$pending = [int](git rev-list --count "$MainBranch..$UpstreamRef")
if ($pending -eq 0) {
    Write-Host '[OK] Ya estamos al día con upstream.' -ForegroundColor Green
    exit 0
}

Write-Host "[INFO] $pending commits nuevos en upstream:" -ForegroundColor Cyan
git log --oneline "$MainBranch..$UpstreamRef" | Select-Object -First 30
if ($pending -gt 30) { Write-Host "  ... y $($pending - 30) más" }

if ($DryRun) {
    Write-Host '[DRY-RUN] No se hace merge. Ejecuta sin -DryRun para sincronizar.'
    exit 0
}

$syncBranch = "sync/upstream-$(Get-Date -Format 'yyyyMMdd')"
git checkout -b $syncBranch $MainBranch
if ($LASTEXITCODE -ne 0) { Fail "No se pudo crear la rama $syncBranch (¿ya existe de un intento anterior?)." }

git merge $UpstreamRef --no-edit
if ($LASTEXITCODE -ne 0) {
    Write-Host '[CONFLICTO] Ficheros a resolver a mano:' -ForegroundColor Yellow
    git diff --name-only --diff-filter=U
    Write-Host ''
    Write-Host 'Pasos para terminar:' -ForegroundColor Yellow
    Write-Host '  1. Resuelve los conflictos (conserva Scheduler/RunSummary y adopta los cambios upstream)'
    Write-Host '  2. git add <ficheros>; git commit --no-edit'
    Write-Host '  3. npm install; npm run build; npm test'
    Write-Host "  4. git checkout $MainBranch; git merge $syncBranch; git branch -d $syncBranch"
    exit 2
}

Write-Host '[INFO] Merge limpio. Instalando dependencias y verificando...'
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install falló. La rama $syncBranch queda para revisar." 3 }
npm run build
if ($LASTEXITCODE -ne 0) { Fail "La compilación falló. La rama $syncBranch queda para revisar." 3 }
npm test
if ($LASTEXITCODE -ne 0) { Fail "Los tests fallaron. La rama $syncBranch queda para revisar." 3 }

if (git status --porcelain -- package-lock.json) {
    git add package-lock.json
    git commit -m 'chore: refresh package-lock after upstream merge'
}

git checkout $MainBranch
git merge $syncBranch --no-edit
if ($LASTEXITCODE -ne 0) { Fail "El merge final a $MainBranch falló." }
git branch -d $syncBranch

Write-Host "[OK] Sincronizado: $pending commits de upstream integrados en $MainBranch." -ForegroundColor Green
if (Get-Command graphify -ErrorAction SilentlyContinue) {
    Write-Host '[INFO] Actualizando grafo de conocimiento (graphify update .)...'
    graphify update .
}
