[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetPathRoot($env:LOCALAPPDATA)
$drive = Get-PSDrive -Name $root[0]
$gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
  Where-Object Name -Match "NVIDIA" |
  Select-Object -ExpandProperty Name
$api = Get-Command mineru-api.exe -ErrorAction SilentlyContinue

[pscustomobject]@{
  platform = [System.Environment]::OSVersion.VersionString
  architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  memory_bytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  disk_free_bytes = $drive.Free
  nvidia_gpu = @($gpu)
  mineru_api = @($api | Select-Object -ExpandProperty Source)
} | ConvertTo-Json -Depth 3
