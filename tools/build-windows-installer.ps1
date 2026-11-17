[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $SpeechRuntime,
    [string] $InnoCompiler = 'ISCC.exe',
    [string] $ElectronDist
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$speech = (Resolve-Path -LiteralPath $SpeechRuntime).Path
$compiler = (Get-Command $InnoCompiler -CommandType Application).Source
$package = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
if (-not $ElectronDist) {
    $ElectronDist = Join-Path $project 'node_modules\electron\dist'
}
$electron = (Resolve-Path -LiteralPath $ElectronDist).Path
$actualElectron = (Get-Content -LiteralPath (Join-Path $electron 'version') -Raw).Trim()
if ($actualElectron -ne $package.dependencies.electron) {
    throw "Expected Electron $($package.dependencies.electron), found $actualElectron."
}

$portableFiles = @(
    'python\python.exe', 'python\python312._pth', 'python\LICENSE.txt',
    'python\Lib\site-packages\faster_whisper\__init__.py',
    'whisper-small\LICENSE.txt', 'whisper-small\config.json',
    'whisper-small\model.bin', 'whisper-small\tokenizer.json', 'whisper-small\vocabulary.txt'
)
foreach ($file in $portableFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $speech $file) -PathType Leaf)) {
        throw "Portable speech runtime is missing $file. Supply embedded Python, its installed dependencies, and Whisper Small."
    }
}
$modelHash = (Get-FileHash -LiteralPath (Join-Path $speech 'whisper-small\model.bin') -Algorithm SHA256).Hash
if ($modelHash -ne '3E305921506D8872816023E4C273E75D2419FB89B24DA97B4FE7BCE14170D671') {
    throw 'Whisper Small checksum mismatch.'
}

Push-Location -LiteralPath $project
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript compilation failed.' }
} finally {
    Pop-Location
}

$runName = $package.version + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$build = (New-Item -ItemType Directory -Path (Join-Path $project ".test-output\windows-installer\$runName") -Force).FullName
$payload = (New-Item -ItemType Directory -Path (Join-Path $build 'payload')).FullName
$output = (New-Item -ItemType Directory -Path (Join-Path $build 'out')).FullName
Get-ChildItem -LiteralPath $electron -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $payload -Recurse
}
Rename-Item -LiteralPath (Join-Path $payload 'electron.exe') -NewName 'InterviewBuddy.exe'
$resources = Join-Path $payload 'resources'
$defaultApp = Join-Path $resources 'default_app.asar'
if (Test-Path -LiteralPath $defaultApp -PathType Leaf) { Remove-Item -LiteralPath $defaultApp }
$application = (New-Item -ItemType Directory -Path (Join-Path $resources 'app')).FullName
foreach ($entry in @('package.json', 'LICENSE', 'dist', 'ui', 'workers')) {
    Copy-Item -LiteralPath (Join-Path $project $entry) -Destination $application -Recurse
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'third-party') -Destination $application -Recurse
$modules = (New-Item -ItemType Directory -Path (Join-Path $application 'node_modules')).FullName
$canvas = (New-Item -ItemType Directory -Path (Join-Path $modules '@napi-rs')).FullName
Copy-Item -LiteralPath (Join-Path $project 'node_modules\pdfjs-dist') -Destination $modules -Recurse
foreach ($entry in @('canvas', 'canvas-win32-x64-msvc')) {
    Copy-Item -LiteralPath (Join-Path $project "node_modules\@napi-rs\$entry") -Destination $canvas -Recurse
}
$runtime = (New-Item -ItemType Directory -Path (Join-Path $application '.runtime\speech') -Force).FullName
Copy-Item -LiteralPath (Join-Path $speech 'python') -Destination $runtime -Recurse
$model = (New-Item -ItemType Directory -Path (Join-Path $runtime 'whisper-small')).FullName
foreach ($entry in $portableFiles | Where-Object { $_ -like 'whisper-small\*' }) {
    Copy-Item -LiteralPath (Join-Path $speech $entry) -Destination $model
}
$assets = (New-Item -ItemType Directory -Path (Join-Path $payload 'assets')).FullName
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'interview-buddy.ico') -Destination $assets

$iss = Join-Path $build 'InterviewBuddy.iss'
$script = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'InterviewBuddy.iss') -Raw
[IO.File]::WriteAllText($iss, $script, [Text.UTF8Encoding]::new($true))
& $compiler '/Qp' "/DAppVersion=$($package.version)" "/DPayloadRoot=$payload" "/DInstallerOutput=$output" $iss
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }

$installer = Join-Path $output "InterviewBuddy-$($package.version)-Windows-x64-Setup.exe"
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($installer + '.sha256') -Value "$hash  $([IO.Path]::GetFileName($installer))" -Encoding ascii
Write-Host "Installer: $installer"
Write-Host "SHA-256:   $hash"
