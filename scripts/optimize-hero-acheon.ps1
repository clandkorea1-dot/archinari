Add-Type -AssemblyName System.Drawing
$in = Resolve-Path "assets\hero-acheon.png"
$out = Join-Path (Resolve-Path "assets").Path "hero-acheon.jpg"
$img = [System.Drawing.Image]::FromFile($in.Path)
try {
  $maxW = 1600
  if ($img.Width -gt $maxW) {
    $newW = $maxW
    $newH = [int][math]::Round($img.Height * ($newW / [double]$img.Width))
    $bmp = New-Object System.Drawing.Bitmap $newW, $newH
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($img, 0, 0, $newW, $newH)
  } else {
    $bmp = New-Object System.Drawing.Bitmap $img
    $g = $null
  }

  $jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1
  $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
  $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 82L)

  $bmp.Save($out, $jpegCodec, $encParams)

  if ($g) { $g.Dispose() }
  $bmp.Dispose()
} finally {
  $img.Dispose()
}

Get-Item $out | Select-Object FullName, Length, LastWriteTime
