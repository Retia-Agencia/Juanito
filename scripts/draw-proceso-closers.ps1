Add-Type -AssemblyName System.Drawing

$W = 1500
$H = 1780
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.Clear([System.Drawing.Color]::FromArgb(247, 249, 252))

# ---- Fonts ----
$fTitle = New-Object System.Drawing.Font("Segoe UI Semibold", 30, [System.Drawing.FontStyle]::Bold)
$fSub   = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Italic)
$fHead  = New-Object System.Drawing.Font("Segoe UI Semibold", 16, [System.Drawing.FontStyle]::Bold)
$fBody  = New-Object System.Drawing.Font("Segoe UI", 13)
$fSmall = New-Object System.Drawing.Font("Segoe UI", 11)
$fTag   = New-Object System.Drawing.Font("Segoe UI Semibold", 11, [System.Drawing.FontStyle]::Bold)

# ---- Brushes ----
$bDark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 41, 59))
$bGray = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100, 116, 139))
$bText = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20, 30, 45))

# String formats
$sfC = New-Object System.Drawing.StringFormat
$sfC.Alignment = [System.Drawing.StringAlignment]::Center
$sfC.LineAlignment = [System.Drawing.StringAlignment]::Center
$sfL = New-Object System.Drawing.StringFormat
$sfL.Alignment = [System.Drawing.StringAlignment]::Near
$sfL.LineAlignment = [System.Drawing.StringAlignment]::Center

function Rect($x, $y, $w, $h) {
  return [System.Drawing.RectangleF]::new([single]$x, [single]$y, [single]$w, [single]$h)
}

function RoundRect($x, $y, $w, $h, $r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $path.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $path.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Box($x, $y, $w, $h, $fillRgb, $borderRgb, $headText, $bodyText) {
  $path = RoundRect $x $y $w $h 14
  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($fillRgb[0], $fillRgb[1], $fillRgb[2]))
  $g.FillPath($fill, $path)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($borderRgb[0], $borderRgb[1], $borderRgb[2]), 2)
  $g.DrawPath($pen, $path)
  if ($headText) {
    $g.DrawString($headText, $fHead, $bText, (Rect ($x + 18) ($y + 12) ($w - 36) 26), $sfL)
  }
  if ($bodyText) {
    $topPad = 14
    if ($headText) { $topPad = 42 }
    $g.DrawString($bodyText, $fBody, $bText, (Rect ($x + 18) ($y + $topPad) ($w - 36) ($h - $topPad - 12)), $sfL)
  }
  $fill.Dispose(); $pen.Dispose(); $path.Dispose()
}

function ArrowDown($x, $y1, $y2) {
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(71, 85, 105), 3)
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::ArrowAnchor
  $g.DrawLine($pen, [single]$x, [single]$y1, [single]$x, [single]$y2)
  $pen.Dispose()
}

# ---- Title ----
$g.DrawString("Proceso comercial - Juanito y los closers", $fTitle, $bDark, (Rect 0 28 $W 44), $sfC)
$g.DrawString("Recordatorios precall automaticos desde Calendly por WhatsApp (anti-ban por diseno)", $fSub, $bGray, (Rect 0 76 $W 24), $sfC)

$cx = 750
$boxW = 720
$bx = $cx - [int]($boxW / 2)

# Colores (RGB arrays)
$blueF = @(219, 234, 254); $blueB = @(59, 130, 246)
$grayF = @(241, 245, 249); $grayB = @(148, 163, 184)
$amberF = @(254, 243, 199); $amberB = @(217, 119, 6)
$greenF = @(220, 252, 231); $greenB = @(22, 163, 74)
$purpF = @(237, 233, 254); $purpB = @(124, 58, 237)

# 1. Prospecto agenda
$y = 120
Box $bx $y $boxW 70 $blueF $blueB "1. El prospecto agenda una llamada" "Reserva su cupo en Calendly con el closer (host del evento)."
ArrowDown $cx ($y + 70) ($y + 108)

# 2. Opt-in
$y = 228
Box $bx $y $boxW 92 $purpF $purpB "2. Opt-in del closer (regla anti-ban)" "Juanito NUNCA escribe primero. El closer le manda un mensaje -> queda`nregistrado y Juanito confirma. Sin opt-in ganado, no se le envia nada."
ArrowDown $cx ($y + 92) ($y + 130)

# 3. Poll
$y = 358
Box $bx $y $boxW 92 $grayF $grayB "3. Juanito vigila Calendly (poll cada 5 min)" "Descubre citas nuevas/reagendadas, identifica al closer por el email`ndel host y agenda los pushes en su cola. Re-valida antes de enviar."
ArrowDown $cx ($y + 92) ($y + 130)

# 4. Header cadencia
$y = 488
$g.DrawString("4. Cadencia de pushes al closer", $fHead, $bDark, (Rect $bx $y $boxW 26), $sfC)

# 4 cajas de push en grid 2x2
$pw = 350; $ph = 96; $gap = 20
$col1 = $cx - $pw - [int]($gap / 2)
$col2 = $cx + [int]($gap / 2)
$row1 = $y + 36
$row2 = $row1 + $ph + $gap

Box $col1 $row1 $pw $ph $amberF $amberB "Push 1 - 7:00 pm" "Resumen de las llamadas de MANANA, agrupadas por closer."
Box $col2 $row1 $pw $ph $amberF $amberB "Push 2 - 6:30 am" "Resumen de las llamadas de HOY, agrupadas por closer."
Box $col1 $row2 $pw $ph $amberF $amberB "Push 0 - inmediato" "Reserva nueva para HOY tras los resumenes (tapa-huecos)."
Box $col2 $row2 $pw $ph $amberF $amberB "Push 3 - 25 min antes" "Uno por llamada, con el link listo para enviar al prospecto."

ArrowDown $cx ($row2 + $ph) ($row2 + $ph + 38)

# 5. Link wa.me
$y = $row2 + $ph + 48
Box $bx $y $boxW 92 $blueF $blueB "5. El closer toca el link del push (wa.me)" "Se abre el chat del prospecto con el mensaje precall YA redactado.`nEl closer solo revisa y le da enviar - cero friccion."
ArrowDown $cx ($y + 92) ($y + 130)

# 6. Prospecto preparado
$y2 = $y + 130
Box $bx $y2 $boxW 70 $blueF $blueB "6. El prospecto recibe su recordatorio" "Llega preparado y a tiempo a la llamada -> menos no-shows."
ArrowDown $cx ($y2 + 70) ($y2 + 108)

# 7. Cierre
$y3 = $y2 + 108
Box $bx $y3 $boxW 70 $greenF $greenB "7. El closer cierra la venta" "Mas llamadas efectivas, mas conversion. Juanito hace el seguimiento operativo."

# ---- Panel lateral: gates anti-ban ----
$panelX = 40; $panelY = 520; $panelW = 300; $panelH = 360
$path = RoundRect $panelX $panelY $panelW $panelH 14
$fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 251, 235))
$g.FillPath($fill, $path)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 83, 9), 2)
$g.DrawPath($pen, $path)
$g.DrawString("Candados anti-ban", $fTag, (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(146, 64, 14))), (Rect ($panelX + 16) ($panelY + 14) ($panelW - 32) 22), $sfL)
$gates = @(
  "* Opt-in GANADO: solo a quien escribio.",
  "* Hilo establecido (contact_jid): si no hay hilo, no se envia.",
  "* Pausa global /calendly off: corta todo al instante.",
  "* Pausa por-closer: silencia a uno solo.",
  "* DRY-RUN: modo ensayo, no envia.",
  "* Re-validacion: cita cancelada o reagendada -> se omite."
)
$gy = $panelY + 48
foreach ($gtxt in $gates) {
  $g.DrawString($gtxt, $fSmall, $bText, (Rect ($panelX + 16) $gy ($panelW - 32) 48), $sfL)
  $gy += 52
}

# ---- Footer ----
$g.DrawString("Juanito (Baileys + Claude) - src/scheduler/calendly.js, src/calendly/*", $fSmall, $bGray, (Rect 0 ($H - 34) $W 22), $sfC)

$out = "C:\Users\aleja\Desktop\Juanito-Proceso-Closers.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "OK -> $out"
