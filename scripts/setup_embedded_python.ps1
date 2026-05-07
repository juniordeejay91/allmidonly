$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VendorRoot = Join-Path $ProjectRoot "vendor\python"
$PythonVersion = "3.11.9"
$PythonZipName = "python-$PythonVersion-embed-amd64.zip"
$PythonZipUrl = "https://www.python.org/ftp/python/$PythonVersion/$PythonZipName"
$PythonZipPath = Join-Path $env:TEMP $PythonZipName
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
$GetPipPath = Join-Path $env:TEMP "get-pip.py"
$RequirementsPath = Join-Path $ProjectRoot "scripts\python\requirements.txt"
$PythonExe = Join-Path $VendorRoot "python.exe"

Write-Host "[Python] preparando runtime embebido en $VendorRoot"

if (Test-Path $VendorRoot) {
  Remove-Item -Recurse -Force $VendorRoot
}
New-Item -ItemType Directory -Force -Path $VendorRoot | Out-Null

Write-Host "[Python] descargando $PythonZipUrl"
Invoke-WebRequest -Uri $PythonZipUrl -OutFile $PythonZipPath

Write-Host "[Python] extrayendo embeddable package"
Expand-Archive -Path $PythonZipPath -DestinationPath $VendorRoot -Force

$PthFile = Get-ChildItem -Path $VendorRoot -Filter "python*._pth" | Select-Object -First 1
if (-not $PthFile) {
  throw "No se encontro el archivo pythonXY._pth en $VendorRoot"
}

$PthContent = Get-Content $PthFile.FullName
$PthContent = $PthContent | Where-Object { $_ -notmatch '^\s*#import site\s*$' }
if (-not ($PthContent -contains "Lib\site-packages")) {
  $PthContent += "Lib\site-packages"
}
if (-not ($PthContent -contains "import site")) {
  $PthContent += "import site"
}
Set-Content -Path $PthFile.FullName -Value $PthContent -Encoding ASCII

$SitePackages = Join-Path $VendorRoot "Lib\site-packages"
New-Item -ItemType Directory -Force -Path $SitePackages | Out-Null

Write-Host "[Python] descargando get-pip.py"
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipPath

Write-Host "[Python] instalando pip"
& $PythonExe $GetPipPath --no-warn-script-location

Write-Host "[Python] instalando dependencias de OCR y proxy"
& $PythonExe -m pip install --no-warn-script-location --upgrade pip
& $PythonExe -m pip install --no-warn-script-location -r $RequirementsPath --target $SitePackages

Write-Host "[Python] runtime listo"
& $PythonExe --version
