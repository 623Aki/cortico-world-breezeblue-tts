param(
  [int]$SampleRate = 24000,
  [int]$Channels = 1,
  [int]$Bits = 16
)

# 常驻 PCM 播放器。
#
# 为什么不用 Media.SoundPlayer：它只能整段文件播放，而本机 TTS 服务是边生成边发音频，
# 等整段合成完再播（长句要好几秒）就会和气泡文字脱节。这里用 winmm 的 waveOut 直接喂
# PCM，收到第一块就能出声。
#
# 协议（stdin，小端序）：
#   [4 字节长度][PCM 字节]   —— 播一块
#   [0][0][0][0]             —— 这一句结束，等播完回一行 drained
#   [1][0][0][0]             —— 立即停（打断/出错），回一行 stopped
# 超过这个长度就当作脏数据丢弃，免得一次读一大坨。
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public class PcmSink : IDisposable
{
    private const int WHDR_DONE = 0x00000001;
    private const uint WAVE_MAPPER = 0xFFFFFFFF;
    private const int MAX_PENDING = 8;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [DllImport("winmm.dll")]
    private static extern int waveOutOpen(out IntPtr hwo, uint uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, uint fdwOpen);
    [DllImport("winmm.dll")]
    private static extern int waveOutPrepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveOutWrite(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveOutUnprepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveOutReset(IntPtr hwo);
    [DllImport("winmm.dll")]
    private static extern int waveOutClose(IntPtr hwo);

    private IntPtr handle;
    private readonly int headerSize;
    private readonly List<IntPtr> headers = new List<IntPtr>();
    private readonly List<IntPtr> blocks = new List<IntPtr>();

    public PcmSink(int sampleRate, int channels, int bits)
    {
        WAVEFORMATEX fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1;
        fmt.nChannels = (ushort)channels;
        fmt.nSamplesPerSec = (uint)sampleRate;
        fmt.wBitsPerSample = (ushort)bits;
        fmt.nBlockAlign = (ushort)(channels * bits / 8);
        fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
        fmt.cbSize = 0;
        int rc = waveOutOpen(out handle, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
        if (rc != 0) throw new Exception("waveOutOpen 失败，返回 " + rc);
        headerSize = Marshal.SizeOf(typeof(WAVEHDR));
    }

    private void ReapDone()
    {
        for (int i = headers.Count - 1; i >= 0; i--)
        {
            WAVEHDR hdr = (WAVEHDR)Marshal.PtrToStructure(headers[i], typeof(WAVEHDR));
            if ((hdr.dwFlags & WHDR_DONE) == 0) continue;  // 还在响
            waveOutUnprepareHeader(handle, headers[i], headerSize);
            Marshal.FreeHGlobal(headers[i]);
            Marshal.FreeHGlobal(blocks[i]);
            headers.RemoveAt(i);
            blocks.RemoveAt(i);
        }
    }

    public void Write(byte[] data)
    {
        if (data == null || data.Length == 0) return;
        ReapDone();
        // 积压太多说明下游比生成慢，等一下，别把内存吃光
        while (headers.Count >= MAX_PENDING)
        {
            Thread.Sleep(5);
            ReapDone();
        }
        IntPtr block = Marshal.AllocHGlobal(data.Length);
        Marshal.Copy(data, 0, block, data.Length);
        IntPtr hdrPtr = Marshal.AllocHGlobal(headerSize);
        WAVEHDR hdr = new WAVEHDR();
        hdr.lpData = block;
        hdr.dwBufferLength = (uint)data.Length;
        Marshal.StructureToPtr(hdr, hdrPtr, false);
        int rc = waveOutPrepareHeader(handle, hdrPtr, headerSize);
        if (rc != 0)
        {
            Marshal.FreeHGlobal(block);
            Marshal.FreeHGlobal(hdrPtr);
            throw new Exception("waveOutPrepareHeader 失败，返回 " + rc);
        }
        rc = waveOutWrite(handle, hdrPtr, headerSize);
        if (rc != 0)
        {
            waveOutUnprepareHeader(handle, hdrPtr, headerSize);
            Marshal.FreeHGlobal(block);
            Marshal.FreeHGlobal(hdrPtr);
            throw new Exception("waveOutWrite 失败，返回 " + rc);
        }
        headers.Add(hdrPtr);
        blocks.Add(block);
    }

    public void Drain()
    {
        while (headers.Count > 0)
        {
            Thread.Sleep(5);
            ReapDone();
        }
    }

    public void Stop()
    {
        waveOutReset(handle);
        Drain();
    }

    public void Dispose()
    {
        try { Stop(); } catch { }
        if (handle != IntPtr.Zero)
        {
            try { waveOutClose(handle); } catch { }
            handle = IntPtr.Zero;
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
} catch {
  [Console]::Error.WriteLine("compile: " + $_.Exception.Message)
  exit 2
}

try {
  $sink = New-Object PcmSink($SampleRate, $Channels, $Bits)
} catch {
  [Console]::Error.WriteLine("open: " + $_.Exception.Message)
  exit 3
}

[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()

$stdin = [Console]::OpenStandardInput()
$lenBuf = New-Object byte[] 4
$total = 0

while ($true) {
  $read = 0
  while ($read -lt 4) {
    try {
      $n = $stdin.Read($lenBuf, $read, 4 - $read)
    } catch {
      $n = 0
    }
    if ($n -le 0) { break }
    $read += $n
  }
  if ($read -lt 4) { break }

  $length = [BitConverter]::ToInt32($lenBuf, 0)
  if ($length -eq 0) {
    $sink.Drain()
    [Console]::Out.WriteLine("drained")
    [Console]::Out.Flush()
    continue
  }
  if ($length -eq 1) {
    $sink.Stop()
    [Console]::Out.WriteLine("stopped")
    [Console]::Out.Flush()
    continue
  }
  if ($length -lt 0 -or $length -gt 33554432) {
    [Console]::Error.WriteLine("bad frame length " + $length)
    break
  }

  $chunk = New-Object byte[] $length
  $got = 0
  while ($got -lt $length) {
    try {
      $n = $stdin.Read($chunk, $got, $length - $got)
    } catch {
      $n = 0
    }
    if ($n -le 0) { break }
    $got += $n
  }
  if ($got -lt $length) { break }

  try {
    $sink.Write($chunk)
    $total += $length
  } catch {
    [Console]::Error.WriteLine("write: " + $_.Exception.Message)
    break
  }
}

$sink.Dispose()
