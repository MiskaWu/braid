#requires -Version 5.1
<#
.SYNOPSIS
  braid 的登入憑證存放（Windows）：存在「認證管理員」（Windows Credential Manager），
  一般認證、目標名稱 braid:<帳號 id>，只有登入這台電腦的你讀得到。

.DESCRIPTION
  憑證只經過標準輸入與輸出，不出現在指令參數裡。
  用法：secret.ps1 set <帳號 id>     從標準輸入讀憑證存起來，印出 credman
        secret.ps1 get <帳號 id>     印出憑證；沒有就結束碼 1
        secret.ps1 delete <帳號 id>
#>
param(
    [Parameter(Position = 0)][string]$Command,
    [Parameter(Position = 1)][string]$Id
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class BraidCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDeleteW(string target, int type, int flags);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    private const int Generic = 1;
    private const int PersistLocalMachine = 2;

    public static void Write(string target, string secret) {
        byte[] bytes = Encoding.Unicode.GetBytes(secret);
        CREDENTIAL c = new CREDENTIAL();
        c.Type = Generic;
        c.TargetName = target;
        c.UserName = "braid";
        c.Persist = PersistLocalMachine;
        c.CredentialBlobSize = bytes.Length;
        c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
            if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            Marshal.FreeHGlobal(c.CredentialBlob);
        }
    }

    public static string Read(string target) {
        IntPtr p;
        if (!CredReadW(target, Generic, 0, out p)) return null;
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            if (c.CredentialBlobSize == 0) return "";
            return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
        } finally {
            CredFree(p);
        }
    }

    public static bool Delete(string target) {
        return CredDeleteW(target, Generic, 0);
    }
}
'@

if ($Id -notmatch '^[A-Za-z0-9._-]{1,80}$') { [Console]::Error.WriteLine("帳號 id 不對：$Id"); exit 2 }
$target = "braid:$Id"

switch ($Command) {
    'set' {
        $token = ([Console]::In.ReadToEnd()) -replace '\s', ''
        if ($token -notmatch '^sk-ant-[A-Za-z0-9_-]{20,}$') { [Console]::Error.WriteLine('這不像 Claude 的登入憑證（應該是 sk-ant- 開頭）'); exit 2 }
        [BraidCredential]::Write($target, $token)
        'credman'
    }
    'get' {
        $token = [BraidCredential]::Read($target)
        if (-not $token) { exit 1 }
        $token
    }
    'delete' {
        [void][BraidCredential]::Delete($target)
    }
    default {
        [Console]::Error.WriteLine('用法：secret.ps1 set|get|delete <帳號 id>')
        exit 2
    }
}
