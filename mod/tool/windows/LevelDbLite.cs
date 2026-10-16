// 最小的 LevelDB 讀寫：只做遷移需要的兩件事。
//   Read   ：找出鍵名含指定字串的最新值（掃 MANIFEST 記載的資料表＋日誌檔）。
//   Append ：在目前的日誌檔尾端追加一筆寫入，下次開啟資料庫時由 LevelDB 自己重播。
// 不支援的格式一律丟例外，呼叫端據此放棄寫入，不猜。
// Windows PowerShell 5.1 的 Add-Type 只吃 C# 5，不要用 $"" 字串、out var 之類的新語法。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

public class CdmEntry
{
    public byte[] Key;
    public ulong Seq;
    public bool Deleted;
    public byte[] Value;
}

public class CdmDbState
{
    public Dictionary<string, CdmEntry> Entries = new Dictionary<string, CdmEntry>();
    public ulong MaxSeq;
    public string ActiveLog;
}

public static class CdmLevelDb
{
    const int BlockSize = 32768;
    const int HeaderSize = 7;
    const ulong TableMagic = 0xdb4775248b80fb57UL;
    static readonly Encoding Latin1 = Encoding.GetEncoding(28591);
    static readonly uint[] CrcTable = MakeCrcTable();

    // ---------- 基本編碼 ----------

    static ulong Varint(byte[] b, ref int p)
    {
        ulong r = 0;
        int shift = 0;
        while (true)
        {
            if (p >= b.Length) throw new InvalidDataException("varint out of range");
            byte c = b[p++];
            r |= (ulong)(c & 0x7f) << shift;
            if ((c & 0x80) == 0) return r;
            shift += 7;
            if (shift > 63) throw new InvalidDataException("varint too long");
        }
    }

    static void PutVarint(List<byte> o, ulong v)
    {
        while (v >= 0x80) { o.Add((byte)(v | 0x80)); v >>= 7; }
        o.Add((byte)v);
    }

    static byte[] Slice(byte[] b, int off, int len)
    {
        if (off < 0 || len < 0 || off + len > b.Length) throw new InvalidDataException("slice out of range");
        byte[] r = new byte[len];
        Buffer.BlockCopy(b, off, r, 0, len);
        return r;
    }

    static byte[] LenPrefixed(byte[] b, ref int p)
    {
        int n = (int)Varint(b, ref p);
        byte[] r = Slice(b, p, n);
        p += n;
        return r;
    }

    static uint[] MakeCrcTable()
    {
        uint[] t = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0x82F63B78u ^ (c >> 1) : c >> 1;
            t[i] = c;
        }
        return t;
    }

    public static uint Crc32c(byte[] b, int off, int len)
    {
        uint c = 0xFFFFFFFFu;
        for (int i = off; i < off + len; i++) c = CrcTable[(c ^ b[i]) & 0xff] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }

    static uint Mask(uint crc) { return ((crc >> 15) | (crc << 17)) + 0xa282ead8u; }

    static byte[] Snappy(byte[] src)
    {
        int p = 0;
        int n = (int)Varint(src, ref p);
        byte[] dst = new byte[n];
        int d = 0;
        while (p < src.Length)
        {
            byte tag = src[p++];
            int kind = tag & 3;
            if (kind == 0)
            {
                int len = tag >> 2;
                if (len >= 60)
                {
                    int bytes = len - 59;
                    len = 0;
                    for (int i = 0; i < bytes; i++) len |= src[p++] << (8 * i);
                }
                len += 1;
                Buffer.BlockCopy(src, p, dst, d, len);
                p += len;
                d += len;
            }
            else
            {
                int len, off;
                if (kind == 1) { len = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
                else if (kind == 2) { len = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
                else { len = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24); p += 4; }
                if (off <= 0 || off > d || d + len > n) throw new InvalidDataException("snappy copy out of range");
                for (int i = 0; i < len; i++) { dst[d] = dst[d - off]; d++; }
            }
        }
        if (d != n) throw new InvalidDataException("snappy length mismatch");
        return dst;
    }

    // app 開著時 Chromium 以「允許別人讀、自己在寫」開著這些檔；一般的整檔讀取要求別人不能寫，會被拒絕。
    // 讀取一律用共用模式；寫入（Append）仍然獨佔開檔，app 開著就失敗。
    static byte[] ReadShared(string path)
    {
        using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            byte[] buf = new byte[fs.Length];
            int off = 0;
            while (off < buf.Length)
            {
                int n = fs.Read(buf, off, buf.Length - off);
                if (n <= 0) break;
                off += n;
            }
            return off == buf.Length ? buf : Slice(buf, 0, off);
        }
    }

    // ---------- 日誌（MANIFEST 與 *.log 共用這個格式） ----------
    // tolerateTail：app 開著時尾端可能正寫到一半，試跑時就當讀到這裡為止（LevelDB 自己也這樣做）；
    // 要寫入時不容忍，殘缺的尾巴後面不接著寫。

    static List<byte[]> ReadLogRecords(byte[] data, bool tolerateTail)
    {
        List<byte[]> recs = new List<byte[]>();
        List<byte> cur = null;
        int pos = 0;
        while (pos < data.Length)
        {
            int left = BlockSize - (pos % BlockSize);
            if (left < HeaderSize) { pos += left; continue; }
            if (pos + HeaderSize > data.Length) { if (tolerateTail) break; throw new InvalidDataException("truncated log header"); }
            uint stored = BitConverter.ToUInt32(data, pos);
            int len = data[pos + 4] | (data[pos + 5] << 8);
            byte type = data[pos + 6];
            if (type == 0 && len == 0) { pos += left; continue; } // 預先配置的空白，跳到下一個區塊
            if (pos + HeaderSize + len > data.Length) { if (tolerateTail) break; throw new InvalidDataException("truncated log record"); }
            if (Mask(Crc32c(data, pos + 6, 1 + len)) != stored)
            {
                if (tolerateTail && pos + HeaderSize + len >= data.Length) break; // 最後一筆寫到一半
                throw new InvalidDataException("log checksum mismatch");
            }
            byte[] payload = Slice(data, pos + HeaderSize, len);
            switch (type)
            {
                case 1: recs.Add(payload); break;
                case 2: cur = new List<byte>(payload); break;
                case 3: if (cur == null) throw new InvalidDataException("log middle without first"); cur.AddRange(payload); break;
                case 4: if (cur == null) throw new InvalidDataException("log last without first"); cur.AddRange(payload); recs.Add(cur.ToArray()); cur = null; break;
                default: throw new InvalidDataException("unknown log record type " + type);
            }
            pos += HeaderSize + len;
        }
        if (cur != null && !tolerateTail) throw new InvalidDataException("log ends inside a fragmented record");
        return recs;
    }

    // ---------- 資料表 ----------

    static byte[] ReadBlock(byte[] b, ulong off, ulong size)
    {
        int o = (int)off, n = (int)size;
        if (o < 0 || n < 0 || o + n + 5 > b.Length) throw new InvalidDataException("block handle out of range");
        uint stored = BitConverter.ToUInt32(b, o + n + 1);
        if (Mask(Crc32c(b, o, n + 1)) != stored) throw new InvalidDataException("table block checksum mismatch");
        byte type = b[o + n];
        byte[] raw = Slice(b, o, n);
        if (type == 0) return raw;
        if (type == 1) return Snappy(raw);
        throw new InvalidDataException("unsupported block compression " + type);
    }

    static void IterateBlock(byte[] blk, Action<byte[], byte[]> cb)
    {
        if (blk.Length < 4) throw new InvalidDataException("block too small");
        uint restarts = BitConverter.ToUInt32(blk, blk.Length - 4);
        long end = blk.Length - 4 - (long)restarts * 4;
        if (end < 0) throw new InvalidDataException("bad restart count");
        int p = 0;
        byte[] last = new byte[0];
        while (p < end)
        {
            int shared = (int)Varint(blk, ref p);
            int nonShared = (int)Varint(blk, ref p);
            int vlen = (int)Varint(blk, ref p);
            if (shared > last.Length) throw new InvalidDataException("bad key prefix");
            byte[] key = new byte[shared + nonShared];
            Buffer.BlockCopy(last, 0, key, 0, shared);
            Buffer.BlockCopy(blk, p, key, shared, nonShared);
            p += nonShared;
            byte[] val = Slice(blk, p, vlen);
            p += vlen;
            cb(key, val);
            last = key;
        }
    }

    static void ReadTable(string path, Action<byte[], byte[]> cb)
    {
        byte[] b = ReadShared(path);
        if (b.Length < 48) throw new InvalidDataException("table too small: " + path);
        if (BitConverter.ToUInt64(b, b.Length - 8) != TableMagic) throw new InvalidDataException("not a leveldb table: " + path);
        int p = b.Length - 48;
        Varint(b, ref p); Varint(b, ref p); // metaindex
        ulong idxOff = Varint(b, ref p), idxSize = Varint(b, ref p);
        byte[] index = ReadBlock(b, idxOff, idxSize);
        IterateBlock(index, (k, v) =>
        {
            int q = 0;
            ulong off = Varint(v, ref q), size = Varint(v, ref q);
            IterateBlock(ReadBlock(b, off, size), cb);
        });
    }

    // ---------- 對外 ----------

    static bool Contains(byte[] hay, byte[] needle)
    {
        if (needle == null) return false;
        for (int i = 0; i + needle.Length <= hay.Length; i++)
        {
            int j = 0;
            while (j < needle.Length && hay[i + j] == needle[j]) j++;
            if (j == needle.Length) return true;
        }
        return false;
    }

    static void Consider(CdmDbState st, byte[] key, ulong seq, bool deleted, byte[] val, byte[] needle)
    {
        if (seq > st.MaxSeq) st.MaxSeq = seq;
        if (!Contains(key, needle)) return;
        string k = Latin1.GetString(key);
        CdmEntry e;
        if (st.Entries.TryGetValue(k, out e) && e.Seq >= seq) return;
        e = new CdmEntry();
        e.Key = key; e.Seq = seq; e.Deleted = deleted; e.Value = val;
        st.Entries[k] = e;
    }

    public static CdmDbState Read(string dir, string needle) { return Read(dir, needle, false); }

    public static CdmDbState Read(string dir, string needle, bool tolerateTail)
    {
        byte[] nb = needle == null ? null : Latin1.GetBytes(needle);
        CdmDbState st = new CdmDbState();
        string current = Encoding.ASCII.GetString(ReadShared(Path.Combine(dir, "CURRENT"))).Trim();
        if (!current.StartsWith("MANIFEST-")) throw new InvalidDataException("unexpected CURRENT: " + current);

        ulong logNumber = 0, prevLog = 0;
        HashSet<ulong> live = new HashSet<ulong>();
        foreach (byte[] rec in ReadLogRecords(ReadShared(Path.Combine(dir, current)), tolerateTail))
        {
            int p = 0;
            while (p < rec.Length)
            {
                ulong tag = Varint(rec, ref p);
                switch (tag)
                {
                    case 1: LenPrefixed(rec, ref p); break;                          // comparator
                    case 2: logNumber = Varint(rec, ref p); break;
                    case 9: prevLog = Varint(rec, ref p); break;
                    case 3: Varint(rec, ref p); break;                               // next file number
                    case 4: { ulong s = Varint(rec, ref p); if (s > st.MaxSeq) st.MaxSeq = s; } break;
                    case 5: Varint(rec, ref p); LenPrefixed(rec, ref p); break;      // compact pointer
                    case 6: Varint(rec, ref p); live.Remove(Varint(rec, ref p)); break;
                    case 7:
                        {
                            Varint(rec, ref p);
                            ulong num = Varint(rec, ref p);
                            Varint(rec, ref p);
                            LenPrefixed(rec, ref p);
                            LenPrefixed(rec, ref p);
                            live.Add(num);
                        }
                        break;
                    default: throw new InvalidDataException("unknown manifest tag " + tag);
                }
            }
        }

        foreach (ulong num in live)
        {
            string path = Path.Combine(dir, num.ToString("D6") + ".ldb");
            if (!File.Exists(path)) path = Path.Combine(dir, num.ToString("D6") + ".sst");
            if (!File.Exists(path)) throw new FileNotFoundException("missing table file " + num);
            ReadTable(path, (ikey, val) =>
            {
                if (ikey.Length < 8) throw new InvalidDataException("internal key too short");
                int ukLen = ikey.Length - 8;
                ulong trailer = BitConverter.ToUInt64(ikey, ukLen);
                Consider(st, Slice(ikey, 0, ukLen), trailer >> 8, (trailer & 0xff) == 0, val, nb);
            });
        }

        List<KeyValuePair<ulong, string>> logs = new List<KeyValuePair<ulong, string>>();
        foreach (string f in Directory.GetFiles(dir, "*.log"))
        {
            ulong n;
            if (ulong.TryParse(Path.GetFileNameWithoutExtension(f), out n) && (n >= logNumber || n == prevLog))
                logs.Add(new KeyValuePair<ulong, string>(n, f));
        }
        logs.Sort((a, b) => a.Key.CompareTo(b.Key));
        foreach (KeyValuePair<ulong, string> log in logs)
        {
            foreach (byte[] rec in ReadLogRecords(ReadShared(log.Value), tolerateTail))
            {
                if (rec.Length < 12) throw new InvalidDataException("write batch too short");
                ulong seq = BitConverter.ToUInt64(rec, 0);
                uint count = BitConverter.ToUInt32(rec, 8);
                int p = 12;
                for (uint i = 0; i < count; i++)
                {
                    byte tag = rec[p++];
                    if (tag == 1) { byte[] k = LenPrefixed(rec, ref p); byte[] v = LenPrefixed(rec, ref p); Consider(st, k, seq + i, false, v, nb); }
                    else if (tag == 0) { byte[] k = LenPrefixed(rec, ref p); Consider(st, k, seq + i, true, null, nb); }
                    else throw new InvalidDataException("unknown batch tag " + tag);
                }
            }
        }
        st.ActiveLog = logs.Count > 0 ? logs[logs.Count - 1].Value : null;
        return st;
    }

    // 追加一筆寫入，回傳用掉的序號。檔案以獨佔方式開啟：app 還開著時會失敗，正好當保險。
    public static ulong Append(string dir, byte[] key, byte[] value)
    {
        CdmDbState st = Read(dir, null);
        if (st.ActiveLog == null) throw new InvalidOperationException("no active log file");
        ulong seq = st.MaxSeq + 1;
        List<byte> batch = new List<byte>();
        batch.AddRange(BitConverter.GetBytes(seq));
        batch.AddRange(BitConverter.GetBytes((uint)1));
        batch.Add(1);
        PutVarint(batch, (ulong)key.Length); batch.AddRange(key);
        PutVarint(batch, (ulong)value.Length); batch.AddRange(value);
        byte[] payload = batch.ToArray();

        using (FileStream fs = new FileStream(st.ActiveLog, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            long len = fs.Length;
            fs.Seek(len, SeekOrigin.Begin);
            int blockOff = (int)(len % BlockSize);
            int left = payload.Length, pos = 0;
            bool begin = true;
            do
            {
                int leftover = BlockSize - blockOff;
                if (leftover < HeaderSize)
                {
                    if (leftover > 0) fs.Write(new byte[leftover], 0, leftover);
                    blockOff = 0;
                }
                int frag = Math.Min(left, BlockSize - blockOff - HeaderSize);
                bool end = frag == left;
                byte type = (byte)(begin && end ? 1 : begin ? 2 : end ? 4 : 3);
                byte[] rec = new byte[HeaderSize + frag];
                rec[4] = (byte)(frag & 0xff);
                rec[5] = (byte)(frag >> 8);
                rec[6] = type;
                Buffer.BlockCopy(payload, pos, rec, HeaderSize, frag);
                BitConverter.GetBytes(Mask(Crc32c(rec, 6, 1 + frag))).CopyTo(rec, 0);
                fs.Write(rec, 0, rec.Length);
                blockOff += rec.Length;
                pos += frag;
                left -= frag;
                begin = false;
            } while (left > 0);
            fs.Flush(true);
        }
        return seq;
    }

    // ---------- Chromium localStorage 的鍵與值 ----------
    // 鍵：'_' + 來源 + 0x00 + 0x01 + 名稱（latin1）；值：0x01 + latin1，或 0x00 + UTF-16LE。

    public static string[] SplitKey(byte[] k)
    {
        if (k.Length < 3 || k[0] != (byte)'_') return null;
        int z = Array.IndexOf(k, (byte)0, 1);
        if (z < 0 || z + 1 >= k.Length) return null;
        string origin = Latin1.GetString(k, 1, z - 1);
        byte enc = k[z + 1];
        string name;
        if (enc == 1) name = Latin1.GetString(k, z + 2, k.Length - z - 2);
        else if (enc == 0) name = Encoding.Unicode.GetString(k, z + 2, k.Length - z - 2);
        else return null;
        return new string[] { origin, name };
    }

    public static byte[] MakeKey(string origin, string name)
    {
        List<byte> o = new List<byte>();
        o.Add((byte)'_');
        o.AddRange(Latin1.GetBytes(origin));
        o.Add(0);
        o.Add(1);
        o.AddRange(Latin1.GetBytes(name));
        return o.ToArray();
    }

    public static string DecodeValue(byte[] v)
    {
        if (v == null || v.Length == 0) throw new InvalidDataException("empty value");
        if (v[0] == 1) return Latin1.GetString(v, 1, v.Length - 1);
        if (v[0] == 0) return Encoding.Unicode.GetString(v, 1, v.Length - 1);
        throw new InvalidDataException("unknown value encoding " + v[0]);
    }

    public static byte[] EncodeValue(string s)
    {
        bool latin = true;
        foreach (char c in s) if (c > 0xff) { latin = false; break; }
        byte[] body = latin ? Latin1.GetBytes(s) : Encoding.Unicode.GetBytes(s);
        byte[] r = new byte[body.Length + 1];
        r[0] = (byte)(latin ? 1 : 0);
        Buffer.BlockCopy(body, 0, r, 1, body.Length);
        return r;
    }
}
