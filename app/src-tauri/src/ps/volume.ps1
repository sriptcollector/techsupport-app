# volume: unmute | up | down | status | 0-100 (the speaker volume of the default output device)
$arg = '__ARG__'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int a(); int b(); int c(); int d(); int SetMasterVolumeLevelScalar(float v, System.Guid ctx); int h(); int GetMasterVolumeLevelScalar(out float v); int i(); int j(); int k(); int l(); int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, System.Guid ctx); int GetMute(out bool m); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int ctx, System.IntPtr p, out IAudioEndpointVolume v); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class TSAudio {
  static IAudioEndpointVolume V() { var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator; IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d)); var g = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v; Marshal.ThrowExceptionForHR(d.Activate(ref g, 23, System.IntPtr.Zero, out v)); return v; }
  public static float GetVol() { float f; Marshal.ThrowExceptionForHR(V().GetMasterVolumeLevelScalar(out f)); return f; }
  public static void SetVol(float x) { Marshal.ThrowExceptionForHR(V().SetMasterVolumeLevelScalar(x, System.Guid.Empty)); }
  public static bool GetMute() { bool b; Marshal.ThrowExceptionForHR(V().GetMute(out b)); return b; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(V().SetMute(m, System.Guid.Empty)); }
}
'@
$was = [math]::Round([TSAudio]::GetVol() * 100); $wasMute = [TSAudio]::GetMute()
if ($arg -eq 'unmute') { [TSAudio]::SetMute($false); if ($was -lt 30) { [TSAudio]::SetVol(0.5) } }
elseif ($arg -eq 'up') { [TSAudio]::SetMute($false); [TSAudio]::SetVol([math]::Min(1.0, [TSAudio]::GetVol() + 0.2)) }
elseif ($arg -eq 'down') { [TSAudio]::SetVol([math]::Max(0.0, [TSAudio]::GetVol() - 0.2)) }
elseif ($arg -match '^\d{1,3}$' -and [int]$arg -le 100) { [TSAudio]::SetMute($false); [TSAudio]::SetVol([int]$arg / 100.0) }
elseif ($arg -eq 'status') { }
else { throw 'volume must be unmute, up, down, status or 0 to 100' }
"Volume is $([math]::Round([TSAudio]::GetVol() * 100)) percent, muted: $([TSAudio]::GetMute()) (it was $was percent, muted: $wasMute)."
