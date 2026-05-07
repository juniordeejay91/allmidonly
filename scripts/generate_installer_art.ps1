Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root "assets\installer"
$logoArtPath = Join-Path $root "assets\images\logoicon.ico"

if (!(Test-Path $installerDir)) {
  New-Item -ItemType Directory -Path $installerDir | Out-Null
}

function New-GradientBrush([int]$width, [int]$height, [string]$startColor, [string]$endColor) {
  return [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Rectangle]::new(0, 0, $width, $height),
    [System.Drawing.ColorTranslator]::FromHtml($startColor),
    [System.Drawing.ColorTranslator]::FromHtml($endColor),
    90
  )
}

function Draw-GlowCircle($graphics, [int]$x, [int]$y, [int]$size, [string]$color, [int]$alpha) {
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb($alpha, [System.Drawing.ColorTranslator]::FromHtml($color)))
  $graphics.FillEllipse($brush, $x, $y, $size, $size)
  $brush.Dispose()
}

function Draw-InstallerSidebar {
  $width = 164
  $height = 314
  $path = Join-Path $installerDir "sidebar.bmp"
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $bgBrush = New-GradientBrush $width $height "#0d1730" "#050814"
  $graphics.FillRectangle($bgBrush, 0, 0, $width, $height)
  $bgBrush.Dispose()

  Draw-GlowCircle $graphics -32 -20 140 "#2a63d8" 48
  Draw-GlowCircle $graphics 70 190 120 "#d4a84f" 30
  Draw-GlowCircle $graphics 118 36 70 "#64b0ff" 22

  $overlayBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(48, 4, 8, 18))
  $graphics.FillRectangle($overlayBrush, 0, 0, $width, $height)
  $overlayBrush.Dispose()

  $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(72, 212, 168, 79), 2)
  $graphics.DrawLine($linePen, 0, 18, $width, 18)
  $graphics.DrawLine($linePen, 0, $height - 26, $width, $height - 26)
  $linePen.Dispose()

  $particlePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(38, 142, 192, 255), 1)
  for ($i = 0; $i -lt 9; $i++) {
    $y = 40 + ($i * 22)
    $graphics.DrawLine($particlePen, 12, $y, 30, $y - 8)
    $graphics.DrawLine($particlePen, 134, $y + 10, 152, $y + 2)
  }
  $particlePen.Dispose()

  if (Test-Path $logoArtPath) {
    $logo = [System.Drawing.Image]::FromFile($logoArtPath)
    $graphics.DrawImage($logo, [System.Drawing.Rectangle]::new(12, 40, 140, 176))
    $logo.Dispose()
  }

  $titleFont = [System.Drawing.Font]::new("Segoe UI Semibold", 14, [System.Drawing.FontStyle]::Bold)
  $subFont = [System.Drawing.Font]::new("Segoe UI", 8.5, [System.Drawing.FontStyle]::Regular)
  $tinyFont = [System.Drawing.Font]::new("Segoe UI", 7.5, [System.Drawing.FontStyle]::Regular)
  $goldBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#f2d48c"))
  $whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#e8f0ff"))
  $mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#8ea4c8"))

  $sideAllText = "ALL "
  $sideMidText = "MID"
  $sideOnlyText = " ONLY"
  $sideStartX = 15
  $sideBaseY = 226
  $sideAllSize = $graphics.MeasureString($sideAllText, $titleFont)
  $sideMidSize = $graphics.MeasureString($sideMidText, $titleFont)
  $graphics.DrawString($sideAllText, $titleFont, $whiteBrush, $sideStartX, $sideBaseY)
  $graphics.DrawString($sideMidText, $titleFont, $goldBrush, $sideStartX + $sideAllSize.Width - 2, $sideBaseY)
  $graphics.DrawString($sideOnlyText, $titleFont, $whiteBrush, $sideStartX + $sideAllSize.Width + $sideMidSize.Width - 4, $sideBaseY)
  $graphics.DrawString("ARAM MAYHEM HELPER", $subFont, $whiteBrush, 16, 258)
  $borderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(110, 41, 66, 110), 1)
  $graphics.DrawRectangle($borderPen, 0, 0, $width - 1, $height - 1)

  $borderPen.Dispose()
  $titleFont.Dispose()
  $subFont.Dispose()
  $tinyFont.Dispose()
  $goldBrush.Dispose()
  $whiteBrush.Dispose()
  $mutedBrush.Dispose()
  $graphics.Dispose()
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bitmap.Dispose()
}

function Draw-InstallerHeader {
  $width = 150
  $height = 57
  $path = Join-Path $installerDir "header.bmp"
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Rectangle]::new(0, 0, $width, $height),
    [System.Drawing.ColorTranslator]::FromHtml("#081120"),
    [System.Drawing.ColorTranslator]::FromHtml("#13254f"),
    0
  )
  $graphics.FillRectangle($bgBrush, 0, 0, $width, $height)
  $bgBrush.Dispose()

  Draw-GlowCircle $graphics 104 -12 58 "#4d8eff" 38
  Draw-GlowCircle $graphics 98 20 34 "#d4a84f" 34

  $goldPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(130, 212, 168, 79), 1)
  $graphics.DrawLine($goldPen, 0, $height - 2, $width, $height - 2)
  $goldPen.Dispose()

  $nameFont = [System.Drawing.Font]::new("Segoe UI Semibold", 13, [System.Drawing.FontStyle]::Bold)
  $subFont = [System.Drawing.Font]::new("Segoe UI", 7.5, [System.Drawing.FontStyle]::Regular)
  $whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#f2f6ff"))
  $goldBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#dcb56a"))
  $mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#8ea4c8"))

  $allText = "ALL "
  $midText = "MID"
  $onlyText = " ONLY"
  $startX = 8
  $baseY = 8
  $allSize = $graphics.MeasureString($allText, $nameFont)
  $midSize = $graphics.MeasureString($midText, $nameFont)
  $graphics.DrawString($allText, $nameFont, $whiteBrush, $startX, $baseY)
  $graphics.DrawString($midText, $nameFont, $goldBrush, $startX + $allSize.Width - 2, $baseY)
  $graphics.DrawString($onlyText, $nameFont, $whiteBrush, $startX + $allSize.Width + $midSize.Width - 4, $baseY)
  $graphics.DrawString("ARAM helper", $subFont, $goldBrush, 10, 31)
  $graphics.DrawString("Installer", $subFont, $mutedBrush, 72, 31)

  $nameFont.Dispose()
  $subFont.Dispose()
  $whiteBrush.Dispose()
  $goldBrush.Dispose()
  $mutedBrush.Dispose()
  $graphics.Dispose()
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bitmap.Dispose()
}

Draw-InstallerSidebar
Draw-InstallerHeader
