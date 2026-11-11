$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- lookup tables ----------
$statusMap = @{ 1 = 'Other'; 2 = 'Unknown'; 3 = 'Idle'; 4 = 'Printing'; 5 = 'Warming up'; 6 = 'Stopped printing'; 7 = 'Offline' }
$errMap = @{ 3 = 'Low paper'; 4 = 'Out of paper'; 5 = 'Low toner'; 6 = 'Out of toner'; 7 = 'Door open'; 8 = 'Paper jam'; 10 = 'Service requested'; 11 = 'Output bin full' }
$gpErrMap = @{
    'PaperJam' = 'Paper jam'; 'PaperOut' = 'Out of paper'; 'PaperProblem' = 'Paper problem'
    'TonerLow' = 'Low toner'; 'NoToner' = 'Out of toner'; 'DoorOpen' = 'Door open'
    'OutputBinFull' = 'Output bin full'; 'UserIntervention' = 'User intervention needed'
    'Error' = 'Printer error'; 'OutOfMemory' = 'Printer out of memory'
}

function Test-Tcp([string]$hostName, [int]$port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $address = $null
        if ([System.Net.IPAddress]::TryParse($hostName, [ref]$address)) {
            $iar = $c.BeginConnect($address, $port, $null, $null)
        } else {
            $iar = $c.BeginConnect($hostName, $port, $null, $null)
        }
        if ($iar.AsyncWaitHandle.WaitOne(1500, $false) -and $c.Connected) {
            $c.EndConnect($iar)
            return $true
        }
        return $false
    } catch { return $false }
    finally { $c.Close() }
}

# ---------- colour-capability cache ----------
# GetPrintCapabilities() opens the printer through the Windows spooler. For an offline / shared (\\server\printer)
# printer that makes Windows pop up "Waiting for printer connection..." on the screen. Colour support almost never
# changes, so it is asked at most once per printer per day, and NEVER for a printer that is unreachable.
$colorCachePath = Join-Path $env:TEMP 'printer-monitor-color-cache.json'
$colorCache = @{}
$colorCacheDirty = $false
try {
    if (Test-Path $colorCachePath) {
        $raw = Get-Content -Raw -Path $colorCachePath | ConvertFrom-Json
        foreach ($prop in $raw.PSObject.Properties) { $colorCache[[string]$prop.Name] = $prop.Value }
    }
} catch { $colorCache = @{} }
$colorCacheTtlSec = 24 * 3600
$nowEpoch = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

# ---------- gather data ----------
$spooler = [string](Get-Service -Name Spooler).Status

$portInfo = @{}
foreach ($pp in @(Get-PrinterPort)) { $portInfo[[string]$pp.Name] = $pp }

$gpMap = @{}
foreach ($g in @(Get-Printer)) { $gpMap[[string]$g.Name] = $g }

$pnpPresent = @(Get-PnpDevice -PresentOnly)
$usbPrintDevs = @($pnpPresent | Where-Object { $_.InstanceId -like 'USBPRINT\*' })
$usbPresent = $usbPrintDevs.Count

# Each USB printer must be matched to ITS OWN device. Counting any USB printer on the PC is not enough: with two
# USB printers, one unplugged one still looked connected because the other one is present.
function Get-Norm([string]$s) { return (($s -replace '[^A-Za-z0-9]', '')).ToUpper() }
$usbDevKeys = @()
foreach ($d in $usbPrintDevs) {
    $idPart = ([string]$d.InstanceId).Split('\')
    if ($idPart.Count -ge 2) { $usbDevKeys += (Get-Norm $idPart[1]) }
    if ($d.FriendlyName) { $usbDevKeys += (Get-Norm ([string]$d.FriendlyName)) }
}
$usbDevKeys = @($usbDevKeys | Where-Object { $_.Length -ge 4 } | Select-Object -Unique)
$usbQueueCount = @(Get-CimInstance -ClassName Win32_Printer | Where-Object { ([string]$_.PortName) -match '^USB' }).Count

# USB / USBDevice entries WITH their Present flag. Printers on the Microsoft IPP Class Driver have no USBPRINT
# device; when one is switched off or unplugged its USB / USBDevice entries stay listed with Present = False.
# Only queried when a USB printer exists, and only for these two classes, so TCP/IP-only shops pay nothing extra.
$usbPnpEntries = @()
if ($usbQueueCount -gt 0) {
    foreach ($d in @(Get-PnpDevice -Class USB, USBDevice | Where-Object { $_.FriendlyName })) {
        $k = Get-Norm ([string]$d.FriendlyName)
        if ($k.Length -ge 4) { $usbPnpEntries += [pscustomobject]@{ Key = $k; Present = [bool]$d.Present } }
    }
}

$results = @()
foreach ($p in @(Get-CimInstance -ClassName Win32_Printer)) {
    $name = [string]$p.Name
    $port = [string]$p.PortName
    $driver = [string]$p.DriverName
    $pi = $portInfo[$port]
    $gp = $gpMap[$name]
    $gpStatus = ''
    if ($gp) { $gpStatus = [string]$gp.PrinterStatus }

    # --- virtual printers (PDF, XPS, OneNote, Fax ...) ---
    $isVirtual = ($port -match '^(PORTPROMPT:|nul:|SHRFAX:|FILE:|XPSPort:|HPSmartPrintingPort)') -or (("$name $driver") -match 'PDF|XPS Document|OneNote|Fax|HP Smart Printing|Snagit|Webex|Zoom')

    # --- connection type ---
    $ip = ''
    $urlPort = 0
    $portNumber = 0
    $portType = 'Other'
    if ($isVirtual) { $portType = 'Virtual' }
    elseif ($pi -and $pi.PrinterHostAddress) { $portType = 'Network (TCP/IP)'; $ip = [string]$pi.PrinterHostAddress }
    elseif ($port -match '^https?://([^/:]+)(?::(\d+))?') {
        $portType = 'Network (IPP)'
        $ip = $Matches[1]
        if ($Matches[2]) { $urlPort = [int]$Matches[2] }
        elseif ($port -match '^https') { $urlPort = 443 }
        else { $urlPort = 631 }
    }
    elseif ($port -match '^WSD') { $portType = 'Network (WSD)' }
    elseif ($port -match '^USB') { $portType = 'USB' }
    elseif ($port -match '^LPT') { $portType = 'Parallel' }
    elseif ($port -match '^COM') { $portType = 'Serial' }
    elseif ($port -match '^\\\\' -or $p.Network) { $portType = 'Shared network printer' }

    # --- offline flags reported by Windows ---
    $workOffline = [bool]$p.WorkOffline
    $offline = $workOffline -or ($p.PrinterStatus -eq 7) -or ($p.ExtendedPrinterStatus -eq 7) -or ($p.DetectedErrorState -eq 9) -or ($gpStatus -eq 'Offline')

    # --- connected / disconnected ---
    $connection = 'connected'
    $detail = ''
    if ($isVirtual) {
        $connection = 'virtual'
        $detail = 'Virtual printer (no physical device)'
    }
    elseif (($portType -eq 'Network (TCP/IP)' -or $portType -eq 'Network (IPP)') -and $ip) {
        $tcpPort = 9100
        if ($portType -eq 'Network (IPP)') { $tcpPort = $urlPort }
        elseif ($pi.PortNumber) { $tcpPort = [int]$pi.PortNumber }
        $portNumber = $tcpPort
        if (Test-Tcp $ip $tcpPort) {
            $detail = "Reachable at ${ip}:${tcpPort}"
            if ($workOffline) { $detail += ' (but set to "Use Printer Offline")' }
        } else {
            $connection = 'disconnected'
            $detail = "No response from ${ip}:${tcpPort}"
        }
    }
    elseif ($portType -eq 'Network (WSD)') {
        # WSD ports carry no IP, so Windows' "online" flag is not reliable.
        # Look for the live WSD device on the network and ping its address.
        $core = (($name -replace '\s*\[.*?\]', '') -replace '\s*\(.*?\)', '').Trim()
        $wsdDevs = @()
        if ($core) {
            $wsdDevs = @($pnpPresent | Where-Object { $_.InstanceId -match 'WSD' -and $_.FriendlyName -and ($_.FriendlyName -like "*$core*") })
        }
        $wsdIp = ''
        foreach ($d in $wsdDevs) {
            $prop = Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName '{656A3BB3-ECC0-43FD-8477-4AE0404A96CD} 12297'
            if ($prop -and $prop.Data) { $wsdIp = [string](@($prop.Data)[0]) }
            if ($wsdIp) { break }
        }
        if ($wsdIp) {
            $ip = $wsdIp
            $alive = (Test-Tcp $wsdIp 5357) -or (Test-Tcp $wsdIp 5358) -or (Test-Tcp $wsdIp 9100) -or (Test-Tcp $wsdIp 80) -or (Test-Tcp $wsdIp 443) -or (Test-Tcp $wsdIp 631) -or (Test-Connection -ComputerName $wsdIp -Count 1 -Quiet)
            if ($alive) { $detail = "Reachable at $wsdIp" }
            else { $connection = 'disconnected'; $detail = "No response from $wsdIp" }
        }
        elseif ($wsdDevs.Count -gt 0) { $detail = 'Printer discovered on the network' }
        else { $connection = 'disconnected'; $detail = 'Printer not discovered on the network (powered off or on another network?)' }
    }
    elseif ($portType -eq 'USB') {
        $nName = Get-Norm $name
        $nDrv = Get-Norm $driver
        $usbMatched = 0
        foreach ($k in $usbDevKeys) {
            if (($nName.Length -ge 4 -and ($k -like "*$nName*" -or $nName -like "*$k*")) -or
                ($nDrv.Length -ge 4 -and ($k -like "*$nDrv*" -or $nDrv -like "*$k*"))) { $usbMatched++ }
        }
        # This printer's own USB devices (by name only - the IPP class driver name is generic): how many exist / are present
        $pnpSeen = 0
        $pnpHere = 0
        foreach ($e in $usbPnpEntries) {
            if ($nName.Length -ge 4 -and ($e.Key -like "*$nName*" -or $nName -like "*$($e.Key)*")) {
                $pnpSeen++
                if ($e.Present) { $pnpHere++ }
            }
        }
        if ($offline) { $connection = 'disconnected'; $detail = 'Windows reports the printer as offline' }
        elseif ($pnpHere -gt 0) { $detail = 'USB device detected' }
        elseif ($pnpSeen -gt 0 -and $usbMatched -eq 0) { $connection = 'disconnected'; $detail = "USB device of this printer is not present on port $port (switched off or cable out)" }
        elseif ($usbPresent -eq 0) { $connection = 'disconnected'; $detail = "No USB printer device detected on port $port (switched off or cable out)" }
        elseif ($usbMatched -gt 0) { $detail = 'USB device detected' }
        elseif ($usbQueueCount -le 1) { $detail = 'USB device detected' }
        else {
            # Two or more USB printers and this one's name matches none of the connected devices.
            # Names can differ (renamed queue), so this is not proof - the agent's job checks decide.
            $detail = 'USB device present (could not match this printer to its own device)'
        }
    }
    else {
        if ($offline) {
            $connection = 'disconnected'
            if ($workOffline) { $detail = 'Set to "Use Printer Offline" or device unreachable' }
            else { $detail = 'Windows reports the printer as offline' }
        } else { $detail = 'Windows reports online (not independently verified)' }
    }

    # --- colour support (done AFTER the connection check so an unreachable printer is never opened) ---
    # 1) Win32_Printer.Capabilities: 2 = Color Printing (cheap; no spooler connection needed).
    # 2) Else the cached answer for this printer (valid 24 h).
    # 3) Else, ONLY for a reachable local printer, ask the driver (OutputColorCapability).
    # $null = could not tell (the dashboard then keeps whatever the shop set).
    $colorCapable = $null
    if (-not $isVirtual) {
        $caps = @($p.Capabilities | Where-Object { $_ -ne $null })
        if ($caps.Count -gt 0) { $colorCapable = ($caps -contains 2) }
        if ($colorCapable -ne $true) {
            $cached = $colorCache[$name]
            if ($cached -and (($nowEpoch - [int]$cached.at) -lt $colorCacheTtlSec)) {
                $colorCapable = [bool]$cached.color
            }
            else {
                $isRemoteConn = ($portType -eq 'Shared network printer') -or ($gp -and ([string]$gp.Type -eq 'Connection'))
                if ($connection -ne 'disconnected' -and -not $offline -and -not $isRemoteConn) {
                    try {
                        if (-not $script:printSrv) {
                            Add-Type -AssemblyName System.Printing
                            $script:printSrv = New-Object System.Printing.LocalPrintServer
                        }
                        $q = $script:printSrv.GetPrintQueue($name)
                        $oc = @($q.GetPrintCapabilities().OutputColorCapability | ForEach-Object { [string]$_ })
                        if ($oc -contains 'Color') { $colorCapable = $true }
                        elseif ($oc.Count -gt 0 -and $colorCapable -eq $null) { $colorCapable = $false }
                        if ($colorCapable -ne $null) {
                            $colorCache[$name] = [pscustomobject]@{ color = [bool]$colorCapable; at = $nowEpoch }
                            $colorCacheDirty = $true
                        }
                    } catch { }
                }
            }
        }
    }

    # --- status text ---
    $statusText = 'Unknown'
    if ($p.PrinterStatus -ne $null -and $statusMap.ContainsKey([int]$p.PrinterStatus)) { $statusText = $statusMap[[int]$p.PrinterStatus] }
    if ($gpStatus -eq 'Paused') { $statusText = 'Paused' }
    if ($isVirtual) { $statusText = 'Ready' }
    elseif ($connection -eq 'disconnected') { $statusText = 'Offline' }

    # --- paper / toner / errors ---
    $paper = 'unknown'
    $toner = 'unknown'
    $errs = New-Object System.Collections.ArrayList

    if ($isVirtual) { $paper = 'na'; $toner = 'na' }
    elseif ($connection -ne 'disconnected') {
        $codes = @()
        if ($p.DetectedErrorState -ne $null) { $codes += [int]$p.DetectedErrorState }
        if ($p.ExtendedDetectedErrorState -ne $null) { $codes += [int]$p.ExtendedDetectedErrorState }

        $jam = ($codes -contains 8) -or ($gpStatus -eq 'PaperJam')
        $out = ($codes -contains 4) -or ($gpStatus -eq 'PaperOut')
        $low = ($codes -contains 3)
        $prob = ($gpStatus -eq 'PaperProblem')

        if ($jam) { $paper = 'jam' }
        elseif ($out) { $paper = 'empty' }
        elseif ($low) { $paper = 'low' }
        elseif ($prob) { $paper = 'problem' }
        elseif (($codes -contains 2) -or ($gpStatus -eq 'Normal')) { $paper = 'ok' }

        if (($codes -contains 6) -or ($gpStatus -eq 'NoToner')) { $toner = 'empty' }
        elseif (($codes -contains 5) -or ($gpStatus -eq 'TonerLow')) { $toner = 'low' }

        foreach ($c in $codes) {
            if ($errMap.ContainsKey($c) -and ($errs -notcontains $errMap[$c])) { [void]$errs.Add($errMap[$c]) }
        }
        if ($gpErrMap.ContainsKey($gpStatus) -and ($errs -notcontains $gpErrMap[$gpStatus])) { [void]$errs.Add($gpErrMap[$gpStatus]) }
    }

    # Get-PrintJob also opens the printer: skip it for printers that are unreachable / offline (no pop-up, faster scan).
    $jobs = 0
    if ($connection -ne 'disconnected' -and -not $offline) { $jobs = @(Get-PrintJob -PrinterName $name).Count }

    $results += [pscustomobject]@{
        name        = $name
        driver      = $driver
        port        = $port
        portType    = $portType
        ipAddress   = $ip
        tcpPort     = [int]$portNumber
        isDefault   = [bool]$p.Default
        isShared    = [bool]$p.Shared
        isVirtual   = [bool]$isVirtual
        connection  = $connection
        detail      = $detail
        status      = $statusText
        paperLevel  = $paper
        tonerLevel  = $toner
        errors      = [string[]]@($errs)
        jobs        = [int]$jobs
        colorCapable = $colorCapable
        location    = [string]$p.Location
        comment     = [string]$p.Comment
    }
}

if ($colorCacheDirty) { try { ($colorCache | ConvertTo-Json -Depth 4 -Compress) | Set-Content -Path $colorCachePath -Encoding UTF8 } catch { } }

$payload = [pscustomobject]@{
    scannedAt = (Get-Date).ToString('o')
    spooler   = $spooler
    printers  = @($results)
}
ConvertTo-Json -InputObject $payload -Depth 5 -Compress
