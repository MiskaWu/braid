// Claude 桌面 app 換帳號遷移：與平台無關的核心。
// macOS 由 migrate.js（JXA，系統內建）提供檔案與互動介面；測試時由 Node 提供同一套介面。
// 演算法與 windows/migrate.ps1 對應，規則都讀 spec.json。改一邊要改另一邊，tests 會用同一份資料驗兩邊。
// 寫成 ES2017：舊版 macOS 的 JavaScriptCore 不認得 ?. 與 ??。
var CDM = (function () {
  'use strict';

  // ================= LevelDB（最小實作：讀最新值、在日誌尾端追加一筆） =================

  var BLOCK = 32768, HEADER = 7;
  var TWO32 = 4294967296;

  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32c(b, off, len) {
    var c = 0xFFFFFFFF;
    for (var i = off; i < off + len; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function mask(crc) { return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0; }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  function u64(b, p) { return u32(b, p) + u32(b, p + 4) * TWO32; }

  function varint(b, pos) {
    var r = 0, mul = 1;
    for (;;) {
      if (pos.p >= b.length) throw new Error('varint out of range');
      var c = b[pos.p++];
      r += (c & 0x7f) * mul;
      if ((c & 0x80) === 0) return r;
      mul *= 128;
      if (mul > Math.pow(2, 56)) throw new Error('varint too long');
    }
  }
  function putVarint(out, v) {
    while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
  }
  function lenPrefixed(b, pos) {
    var n = varint(b, pos);
    if (pos.p + n > b.length) throw new Error('slice out of range');
    var r = b.subarray(pos.p, pos.p + n);
    pos.p += n;
    return r;
  }

  function snappy(src) {
    var pos = { p: 0 };
    var n = varint(src, pos);
    var dst = new Uint8Array(n), d = 0, p = pos.p;
    while (p < src.length) {
      var tag = src[p++], kind = tag & 3, len, off;
      if (kind === 0) {
        len = tag >>> 2;
        if (len >= 60) {
          var bytes = len - 59; len = 0;
          for (var i = 0; i < bytes; i++) len += src[p++] * Math.pow(256, i);
        }
        len += 1;
        dst.set(src.subarray(p, p + len), d); p += len; d += len;
      } else {
        if (kind === 1) { len = ((tag >>> 2) & 7) + 4; off = ((tag >>> 5) << 8) | src[p++]; }
        else if (kind === 2) { len = (tag >>> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
        else { len = (tag >>> 2) + 1; off = u32(src, p); p += 4; }
        if (off <= 0 || off > d || d + len > n) throw new Error('snappy copy out of range');
        for (var j = 0; j < len; j++) { dst[d] = dst[d - off]; d++; }
      }
    }
    if (d !== n) throw new Error('snappy length mismatch');
    return dst;
  }

  function readLogRecords(data) {
    var recs = [], cur = null, pos = 0;
    while (pos < data.length) {
      var left = BLOCK - (pos % BLOCK);
      if (left < HEADER) { pos += left; continue; }
      if (pos + HEADER > data.length) throw new Error('truncated log header');
      var stored = u32(data, pos), len = data[pos + 4] | (data[pos + 5] << 8), type = data[pos + 6];
      if (type === 0 && len === 0) { pos += left; continue; }
      if (pos + HEADER + len > data.length) throw new Error('truncated log record');
      if (mask(crc32c(data, pos + 6, 1 + len)) !== stored) throw new Error('log checksum mismatch');
      var payload = data.subarray(pos + HEADER, pos + HEADER + len);
      if (type === 1) recs.push(payload);
      else if (type === 2) cur = [payload];
      else if (type === 3) { if (!cur) throw new Error('log middle without first'); cur.push(payload); }
      else if (type === 4) { if (!cur) throw new Error('log last without first'); cur.push(payload); recs.push(concat(cur)); cur = null; }
      else throw new Error('unknown log record type ' + type);
      pos += HEADER + len;
    }
    if (cur) throw new Error('log ends inside a fragmented record');
    return recs;
  }

  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var r = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) { r.set(parts[i], o); o += parts[i].length; }
    return r;
  }

  function readBlock(b, off, size) {
    if (off + size + 5 > b.length) throw new Error('block handle out of range');
    if (mask(crc32c(b, off, size + 1)) !== u32(b, off + size + 1)) throw new Error('table block checksum mismatch');
    var type = b[off + size], raw = b.subarray(off, off + size);
    if (type === 0) return raw;
    if (type === 1) return snappy(raw);
    throw new Error('unsupported block compression ' + type);
  }

  function iterateBlock(blk, cb) {
    var restarts = u32(blk, blk.length - 4), end = blk.length - 4 - restarts * 4;
    if (end < 0) throw new Error('bad restart count');
    var pos = { p: 0 }, last = new Uint8Array(0);
    while (pos.p < end) {
      var shared = varint(blk, pos), nonShared = varint(blk, pos), vlen = varint(blk, pos);
      if (shared > last.length) throw new Error('bad key prefix');
      var key = new Uint8Array(shared + nonShared);
      key.set(last.subarray(0, shared), 0);
      key.set(blk.subarray(pos.p, pos.p + nonShared), shared);
      pos.p += nonShared;
      var val = blk.subarray(pos.p, pos.p + vlen);
      pos.p += vlen;
      cb(key, val);
      last = key;
    }
  }

  function readTable(b, cb) {
    if (b.length < 48) throw new Error('table too small');
    if (u32(b, b.length - 8) !== 0x8b80fb57 || u32(b, b.length - 4) !== 0xdb477524) throw new Error('not a leveldb table');
    var pos = { p: b.length - 48 };
    varint(b, pos); varint(b, pos);
    var idxOff = varint(b, pos), idxSize = varint(b, pos);
    iterateBlock(readBlock(b, idxOff, idxSize), function (k, v) {
      var q = { p: 0 };
      var off = varint(v, q), size = varint(v, q);
      iterateBlock(readBlock(b, off, size), cb);
    });
  }

  function latin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + 8192));
    return s;
  }
  function latin1Bytes(s) {
    var r = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) r[i] = s.charCodeAt(i) & 0xff;
    return r;
  }
  function contains(hay, needle) {
    if (!needle) return false;
    outer: for (var i = 0; i + needle.length <= hay.length; i++) {
      for (var j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  function lsRead(io, dir, needle) {
    var nb = needle == null ? null : latin1Bytes(needle);
    var st = { entries: {}, maxSeq: 0, activeLog: null };
    function consider(key, seq, deleted, val) {
      if (seq > st.maxSeq) st.maxSeq = seq;
      if (!contains(key, nb)) return;
      var k = latin1(key), e = st.entries[k];
      if (e && e.seq >= seq) return;
      st.entries[k] = { key: key, seq: seq, deleted: deleted, value: val };
    }
    var current = io.readText(io.join(dir, 'CURRENT')).trim();
    if (current.indexOf('MANIFEST-') !== 0) throw new Error('unexpected CURRENT: ' + current);
    var logNumber = 0, prevLog = 0, live = {};
    readLogRecords(io.readBytes(io.join(dir, current))).forEach(function (rec) {
      var pos = { p: 0 };
      while (pos.p < rec.length) {
        var tag = varint(rec, pos);
        switch (tag) {
          case 1: lenPrefixed(rec, pos); break;
          case 2: logNumber = varint(rec, pos); break;
          case 9: prevLog = varint(rec, pos); break;
          case 3: varint(rec, pos); break;
          case 4: var s = varint(rec, pos); if (s > st.maxSeq) st.maxSeq = s; break;
          case 5: varint(rec, pos); lenPrefixed(rec, pos); break;
          case 6: varint(rec, pos); delete live[varint(rec, pos)]; break;
          case 7: varint(rec, pos); var num = varint(rec, pos); varint(rec, pos); lenPrefixed(rec, pos); lenPrefixed(rec, pos); live[num] = true; break;
          default: throw new Error('unknown manifest tag ' + tag);
        }
      }
    });
    Object.keys(live).forEach(function (num) {
      var name = ('000000' + num).slice(-Math.max(6, String(num).length));
      var path = io.join(dir, name + '.ldb');
      if (!io.exists(path)) path = io.join(dir, name + '.sst');
      if (!io.exists(path)) throw new Error('missing table file ' + num);
      readTable(io.readBytes(path), function (ikey, val) {
        if (ikey.length < 8) throw new Error('internal key too short');
        var n = ikey.length - 8, lo = u32(ikey, n), hi = u32(ikey, n + 4);
        consider(ikey.subarray(0, n), hi * 16777216 + Math.floor(lo / 256), (lo & 0xff) === 0, val);
      });
    });
    var logs = io.listDir(dir).filter(function (f) { return /^\d+\.log$/.test(f); })
      .map(function (f) { return { n: parseInt(f, 10), f: f }; })
      .filter(function (x) { return x.n >= logNumber || x.n === prevLog; })
      .sort(function (a, b) { return a.n - b.n; });
    logs.forEach(function (x) {
      readLogRecords(io.readBytes(io.join(dir, x.f))).forEach(function (rec) {
        if (rec.length < 12) throw new Error('write batch too short');
        var seq = u64(rec, 0), count = u32(rec, 8), pos = { p: 12 };
        for (var i = 0; i < count; i++) {
          var tag = rec[pos.p++];
          if (tag === 1) { var k = lenPrefixed(rec, pos), v = lenPrefixed(rec, pos); consider(k, seq + i, false, v); }
          else if (tag === 0) { consider(lenPrefixed(rec, pos), seq + i, true, null); }
          else throw new Error('unknown batch tag ' + tag);
        }
      });
    });
    st.activeLog = logs.length ? io.join(dir, logs[logs.length - 1].f) : null;
    return st;
  }

  function lsAppend(io, dir, key, value) {
    var st = lsRead(io, dir, null);
    if (!st.activeLog) throw new Error('no active log file');
    var seq = st.maxSeq + 1, batch = [];
    var lo = seq % TWO32, hi = Math.floor(seq / TWO32), i;
    for (i = 0; i < 4; i++) batch.push((lo >>> (8 * i)) & 0xff);
    for (i = 0; i < 4; i++) batch.push((hi >>> (8 * i)) & 0xff);
    batch.push(1, 0, 0, 0, 1);
    putVarint(batch, key.length); for (i = 0; i < key.length; i++) batch.push(key[i]);
    putVarint(batch, value.length);
    var payload = concat([new Uint8Array(batch), value]);

    var blockOff = io.fileSize(st.activeLog) % BLOCK, left = payload.length, pos = 0, begin = true, out = [];
    do {
      var leftover = BLOCK - blockOff;
      if (leftover < HEADER) { if (leftover > 0) out.push(new Uint8Array(leftover)); blockOff = 0; }
      var frag = Math.min(left, BLOCK - blockOff - HEADER), end = frag === left;
      var rec = new Uint8Array(HEADER + frag);
      rec[4] = frag & 0xff; rec[5] = frag >>> 8;
      rec[6] = begin && end ? 1 : begin ? 2 : end ? 4 : 3;
      rec.set(payload.subarray(pos, pos + frag), HEADER);
      var c = mask(crc32c(rec, 6, 1 + frag));
      rec[0] = c & 0xff; rec[1] = (c >>> 8) & 0xff; rec[2] = (c >>> 16) & 0xff; rec[3] = (c >>> 24) & 0xff;
      out.push(rec);
      blockOff += rec.length; pos += frag; left -= frag; begin = false;
    } while (left > 0);
    io.appendBytes(st.activeLog, concat(out));
    return seq;
  }

  // Chromium localStorage：鍵＝'_'＋來源＋0x00＋0x01＋名稱；值＝0x01＋latin1 或 0x00＋UTF-16LE
  function splitKey(k) {
    if (k.length < 3 || k[0] !== 0x5f) return null;
    var z = -1;
    for (var i = 1; i < k.length; i++) if (k[i] === 0) { z = i; break; }
    if (z < 0 || z + 1 >= k.length) return null;
    var body = k.subarray(z + 2);
    var name = k[z + 1] === 1 ? latin1(body) : k[z + 1] === 0 ? utf16(body) : null;
    return name === null ? null : [latin1(k.subarray(1, z)), name];
  }
  function makeKey(origin, name) { return concat([latin1Bytes('_' + origin), new Uint8Array([0, 1]), latin1Bytes(name)]); }
  function utf16(b) {
    var s = '';
    for (var i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
    return s;
  }
  function decodeValue(v) {
    if (!v || !v.length) throw new Error('empty value');
    if (v[0] === 1) return latin1(v.subarray(1));
    if (v[0] === 0) return utf16(v.subarray(1));
    throw new Error('unknown value encoding ' + v[0]);
  }
  function encodeValue(s) {
    if (/^[\x00-\xff]*$/.test(s)) return concat([new Uint8Array([1]), latin1Bytes(s)]);
    var r = new Uint8Array(1 + s.length * 2);
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); r[1 + 2 * i] = c & 0xff; r[2 + 2 * i] = c >>> 8; }
    return r;
  }

  // ================= 遷移流程 =================

  function has(o, k) { return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }
  function short(id) { return id.length > 8 ? id.slice(0, 8) : id; }
  function titleOf(e) { return has(e, 'title') ? e.title : '（無標題）'; }
  function fmtTime(ms) {
    if (!ms) return '（無紀錄）';
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function placeKey(t) { return t ? [t.kind, t.cwd, t.wslDistro].map(function (x) { return x == null ? '' : x; }).join('|') : '||'; }
  function byLastDesc(a, b) { return (b.data.lastActivityAt || 0) - (a.data.lastActivityAt || 0); }

  function mergePresetState(a, b) {
    var have = {}, ids = {}, added = [], skipped = [];
    var list = arr(b.presets).slice();
    list.forEach(function (p) { have[placeKey(p.target)] = true; ids[String(p.id)] = true; });
    arr(a.presets).forEach(function (p) {
      var k = placeKey(p.target);
      if (have[k] || ids[String(p.id)]) { skipped.push(String(p.name)); return; }
      list.push(p); added.push(String(p.name)); have[k] = true;
    });
    b.presets = list;
    if (has(a, 'placeDefaults')) {
      if (!b.placeDefaults) b.placeDefaults = {};
      Object.keys(a.placeDefaults || {}).forEach(function (k) { if (!has(b.placeDefaults, k)) b.placeDefaults[k] = a.placeDefaults[k]; });
    }
    if (has(a, 'startedPlaces')) {
      var places = arr(b.startedPlaces).slice(), seen = {};
      places.forEach(function (p) { seen[placeKey(p.target)] = true; });
      arr(a.startedPlaces).forEach(function (p) { if (!seen[placeKey(p.target)]) places.push(p); });
      b.startedPlaces = places;
    }
    if (has(a, 'startedFrom')) {
      var from = [];
      arr(b.startedFrom).concat(arr(a.startedFrom)).forEach(function (x) { if (from.indexOf(x) < 0) from.push(x); });
      b.startedFrom = from;
    }
    return { added: added, skipped: skipped };
  }

  function makeUi(io, opts) {
    var interactive = io.interactive && !opts.yes;
    return {
      say: function (msg, color) { io.say(msg, color); },
      ask: function (prompt, choices, def, auto) {
        if (!interactive) return auto;
        for (;;) {
          var a = String(io.readLine(prompt) || '').trim().toUpperCase();
          if (a === '') return def;
          if (choices.indexOf(a) >= 0) return a;
        }
      },
      step: function (what, action) {
        for (;;) {
          try { action(); return true; } catch (e) {
            io.say('  ✗ ' + what + ' 失敗：' + e.message, 'yellow');
            var a = this.ask('    [R] 重試  [S] 略過這一項  [C] 取消全部（直接按 Enter＝重試）', ['R', 'S', 'C'], 'R', 'C');
            if (a === 'S') return false;
            if (a === 'C') throw new Error('CANCEL');
          }
        }
      },
    };
  }

  function waitAppClosed(io, ui, opts) {
    if (opts.skipAppCheck || !io.isAppRunning()) return;
    ui.say('');
    ui.say('Claude 桌面 app 還開著。請從選單列按 Claude →「結束 Claude」（⌘Q），只關掉視窗不夠。', 'yellow');
    var a = ui.ask('  [Y] 由這裡請 Claude 結束（系統可能會問是否允許，按「好」）  [N] 我自己結束（直接按 Enter＝N）', ['Y', 'N'], 'N', 'N');
    if (a === 'Y') { try { io.quitApp(); } catch (e) { ui.say('  沒辦法代為結束：' + e.message + '。請自己結束 Claude。', 'yellow'); } }
    ui.say('等待 app 結束中……（按 Ctrl+C 取消）');
    while (io.isAppRunning()) io.sleep(0.3);
    io.sleep(0.5);
    ui.say('app 已結束。', 'green');
  }

  function readProfile(io, ui, spec, acct, org, dir) {
    var entries = [];
    io.listDir(dir).filter(function (n) { return n.indexOf(spec.sessions.filePrefix) === 0 && /\.json$/.test(n); }).sort().forEach(function (n) {
      try { entries.push({ name: n, data: JSON.parse(io.readText(io.join(dir, n))) }); }
      catch (e) { ui.say('  略過無法解析的檔案：' + n, 'gray'); }
    });
    var last = 0;
    entries.forEach(function (x) { if (x.data.lastActivityAt > last) last = x.data.lastActivityAt; });
    return { account: acct, org: org, dir: dir, entries: entries, count: entries.length, last: last };
  }

  function showProfile(ui, p, label) {
    ui.say('  ' + label + '帳號 ' + short(p.account) + '…／組織 ' + short(p.org) + '…：' + p.count + ' 筆 session，最後活動 ' + fmtTime(p.last));
    p.entries.slice().sort(byLastDesc).slice(0, 3).forEach(function (x) { ui.say('      · ' + titleOf(x.data), 'gray'); });
  }

  // found／missing／unverifiable
  function testTranscript(io, opts, e) {
    var id = e.cliSessionId;
    var distro = e.wslConfig && e.wslConfig.distro ? e.wslConfig.distro : null;
    var remote = has(e, 'sshRemoteTranscriptPath') ? e.sshRemoteTranscriptPath : null;
    if (distro) {
      var root = io.wslRoot(distro);
      if (root === null) return 'unverifiable';
      if (remote) return io.exists(root + remote) ? 'found' : 'missing';
      return 'unverifiable';
    }
    if (remote) return 'unverifiable';
    var projects = io.join(opts.claudeHome, 'projects');
    if (!io.isDir(projects)) return 'missing';
    var dirs = io.listDir(projects);
    for (var i = 0; i < dirs.length; i++) if (io.exists(io.join(projects, dirs[i], id + '.jsonl'))) return 'found';
    return 'missing';
  }

  function migrate(io, opts) {
    var spec = opts.spec, ui = makeUi(io, opts), backupDir = null;
    try {
      ui.say('== Claude 桌面 app 換帳號遷移 ==', 'cyan');
      ui.say('只複製、不搬移；寫入前會先備份。不需要系統管理員權限。');
      ui.say('');
      if (!io.isDir(opts.appDataRoot)) throw new Error('找不到 Claude 桌面 app 的資料夾：' + opts.appDataRoot);
      waitAppClosed(io, ui, opts);

      // --- 找帳號 ---
      var sessRoot = io.join(opts.appDataRoot, spec.sessions.dir);
      if (!io.isDir(sessRoot)) throw new Error('找不到 session 資料夾：' + sessRoot + '（這台電腦還沒用過 Code 分頁？）');
      var profiles = [];
      io.listDir(sessRoot).forEach(function (acct) {
        var ad = io.join(sessRoot, acct);
        if (!io.isDir(ad)) return;
        io.listDir(ad).forEach(function (org) {
          var od = io.join(ad, org);
          if (io.isDir(od)) profiles.push(readProfile(io, ui, spec, acct, org, od));
        });
      });
      var current = null, cfgPath = io.join(opts.appDataRoot, spec.app.configFile);
      if (io.exists(cfgPath)) {
        var cfg = JSON.parse(io.readText(cfgPath));
        if (has(cfg, spec.app.currentAccountKey)) current = cfg[spec.app.currentAccountKey];
      }
      var target = profiles.filter(function (p) { return p.account === current; }).sort(function (a, b) { return b.last - a.last; })[0];
      if (!target) {
        ui.say('找不到目前登入帳號的 session 資料夾。', 'red');
        ui.say('請先用新帳號登入桌面 app，在 Code 分頁開一個新對話（打一句話就好），結束 app 後再執行一次。');
        return 2;
      }
      var sources = profiles.filter(function (p) { return p.dir !== target.dir && p.count > 0; }).sort(function (a, b) { return b.last - a.last; });
      if (!sources.length) { ui.say('這台電腦上沒有其他帳號的 session 可以遷移。', 'green'); return 0; }

      ui.say('目前登入（搬到這裡）：', 'cyan');
      showProfile(ui, target, '');
      ui.say('');
      var source = null;
      if (opts.from) {
        source = sources.filter(function (p) { return p.account.indexOf(opts.from) === 0 || (p.account + '.' + p.org).indexOf(opts.from) === 0; })[0];
        if (!source) throw new Error('找不到 --from 指定的帳號：' + opts.from);
      } else if (sources.length === 1) {
        source = sources[0];
      } else {
        ui.say('這台電腦上有多個舊帳號，請選要從哪一個搬：', 'cyan');
        sources.forEach(function (p, i) { showProfile(ui, p, '[' + (i + 1) + '] '); });
        if (!io.interactive || opts.yes) throw new Error('有多個舊帳號，請用 --from 指定');
        while (!source) {
          var n = parseInt(io.readLine('輸入編號 1-' + sources.length), 10);
          if (n >= 1 && n <= sources.length) source = sources[n - 1];
        }
      }
      ui.say('從這個帳號搬：', 'cyan');
      showProfile(ui, source, '');
      ui.say('');

      // --- 規劃 session ---
      var prefix = spec.sessions.filePrefix, tp = spec.sessions.tombstonePrefix;
      var tgtNames = {}, tombs = {};
      target.entries.forEach(function (x) { tgtNames[x.name] = true; });
      io.listDir(target.dir).forEach(function (n) { if (n.indexOf(tp) === 0) tombs[n.slice(tp.length)] = true; });
      var latest = target.entries.slice().sort(byLastDesc)[0], replace = {};
      spec.sessions.replaceFromTarget.forEach(function (k) { if (latest && has(latest.data, k)) replace[k] = latest.data[k]; });

      var copy = [], skip = [], unverifiable = [];
      source.entries.forEach(function (x) {
        var e = x.data, uuid = x.name.slice(prefix.length, -5), reason = null;
        if (tgtNames[x.name]) reason = 'exists';
        else if (tombs[uuid]) reason = 'tombstone';
        else spec.sessions.requiredKeys.forEach(function (k) { if (!has(e, k)) reason = 'invalid'; });
        if (!reason) {
          var t = testTranscript(io, opts, e);
          if (t === 'missing') reason = 'missing-transcript';
          else if (t === 'unverifiable') { unverifiable.push(x); return; }
        }
        if (reason) skip.push({ file: x.name, title: titleOf(e), reason: reason });
        else copy.push(x);
      });
      if (unverifiable.length) {
        ui.say('有 ' + unverifiable.length + ' 筆 session 的對話紀錄在 WSL 或遠端主機上，這裡確認不到是否還在：', 'yellow');
        unverifiable.forEach(function (x) { ui.say('      · ' + titleOf(x.data), 'gray'); });
        var yes = ui.ask('  仍要複製這些 session 嗎？[Y/N]（直接按 Enter＝Y）', ['Y', 'N'], 'Y', 'Y') === 'Y';
        unverifiable.forEach(function (x) {
          if (yes) copy.push(x);
          else skip.push({ file: x.name, title: titleOf(x.data), reason: 'unverifiable-declined' });
        });
      }

      var idxSrc = io.join(source.dir, spec.sessions.archivedIndex), idxDst = io.join(target.dir, spec.sessions.archivedIndex);
      var present = {};
      Object.keys(tgtNames).forEach(function (n) { present[n.slice(0, -5)] = true; });
      copy.forEach(function (x) { present[x.name.slice(0, -5)] = true; });
      var dstIdx = io.exists(idxDst) ? JSON.parse(io.readText(idxDst)) : { v: 1, archived: [] };
      var addArchived = [];
      if (io.exists(idxSrc)) {
        arr(JSON.parse(io.readText(idxSrc)).archived).forEach(function (id) {
          if (present[id] && arr(dstIdx.archived).indexOf(id) < 0) addArchived.push(id);
        });
      }

      // --- 規劃環境 ---
      var presetPlans = [], lsDir = io.join.apply(null, [opts.appDataRoot].concat(spec.presets.localStorageDir.split('/')));
      if (io.isDir(lsDir)) {
        try {
          var state = lsRead(io, lsDir, spec.presets.keyPrefix), byName = {}, kp = spec.presets.keyPrefix;
          Object.keys(state.entries).forEach(function (k) {
            var en = state.entries[k];
            if (en.deleted) return;
            var parts = splitKey(en.key);
            if (!parts || parts[1].indexOf(kp) !== 0) return;
            byName[parts[1]] = { origin: parts[0], json: decodeValue(en.value) };
          });
          [
            { scope: 'account', label: '帳號層級', src: kp + source.account, dst: kp + target.account },
            { scope: 'org', label: '組織層級', src: kp + source.account + '.' + source.org, dst: kp + target.account + '.' + target.org },
          ].forEach(function (s) {
            var plan = { scope: s.scope, label: s.label, status: 'none', reason: null, added: [], skipped: [], origin: null, dstName: s.dst, newJson: null, presets: null };
            presetPlans.push(plan);
            if (!byName[s.src]) return;
            var a = JSON.parse(byName[s.src].json);
            if (!a.state || !arr(a.state.presets).length) return;
            if (spec.presets.supportedVersions.indexOf(a.version) < 0) { plan.status = 'skip'; plan.reason = 'unsupported-version:' + a.version; return; }
            if (!byName[s.dst]) { plan.status = 'skip'; plan.reason = 'target-missing'; return; }
            var b = JSON.parse(byName[s.dst].json);
            if (b.version !== a.version || !b.state) { plan.status = 'skip'; plan.reason = 'version-mismatch:' + a.version + '/' + b.version; return; }
            var m = mergePresetState(a.state, b.state);
            plan.added = m.added; plan.skipped = m.skipped;
            if (!m.added.length) { plan.status = 'nothing-new'; return; }
            plan.status = 'merge'; plan.origin = byName[s.dst].origin;
            plan.newJson = JSON.stringify(b); plan.presets = b.state.presets;
          });
        } catch (e) {
          ui.say('讀不了環境資料：' + e.message, 'yellow');
          if (ui.ask('  [Y] 只搬側欄 session、略過環境  [N] 取消（直接按 Enter＝Y）', ['Y', 'N'], 'Y', 'Y') !== 'Y') throw new Error('CANCEL');
          presetPlans = [{ scope: 'account', label: '帳號層級', status: 'skip', reason: 'read-failed', added: [], skipped: [] }];
        }
      }

      // --- 列出計畫 ---
      var reasonText = { exists: '新帳號已經有了', tombstone: '曾在新帳號刪除過', invalid: '檔案格式不符', 'missing-transcript': '找不到對話紀錄檔', 'unverifiable-declined': '你選擇不複製' };
      ui.say('== 遷移計畫 ==', 'cyan');
      ui.say('側欄 session：複製 ' + copy.length + ' 筆，略過 ' + skip.length + ' 筆；封存狀態補 ' + addArchived.length + ' 筆');
      copy.forEach(function (x) { ui.say('  + ' + titleOf(x.data), 'green'); });
      skip.filter(function (s) { return s.reason !== 'exists'; }).forEach(function (s) { ui.say('  - ' + s.title + '（' + reasonText[s.reason] + '）', 'gray'); });
      var existsCount = skip.filter(function (s) { return s.reason === 'exists'; }).length;
      if (existsCount) ui.say('  （另有 ' + existsCount + ' 筆新帳號已經有了）', 'gray');
      ui.say('已儲存的環境：');
      if (!presetPlans.length) ui.say('  這台電腦沒有環境資料，略過。', 'gray');
      presetPlans.forEach(function (p) {
        if (p.status === 'merge') {
          ui.say('  ' + p.label + '：加入 ' + p.added.join('、'), 'green');
          if (p.skipped.length) ui.say('    略過（新帳號已有同一個資料夾）：' + p.skipped.join('、'), 'gray');
        } else if (p.status === 'nothing-new') ui.say('  ' + p.label + '：都已經有了', 'gray');
        else if (p.status === 'skip') {
          var why = p.reason === 'target-missing' ? '新帳號還沒有環境資料：請先用新帳號在 Code 分頁開過一次對話'
            : /^unsupported-version/.test(p.reason) ? 'app 的環境資料格式改版了，本工具還不認得，請更新工具'
              : /^version-mismatch/.test(p.reason) ? '新舊帳號的環境資料格式版本不同' : '讀取失敗';
          ui.say('  ' + p.label + '：略過（' + why + '）', 'yellow');
        }
      });
      ui.say('');

      if (opts.planJson) {
        var planOut = {
          source: { account: source.account, org: source.org },
          target: { account: target.account, org: target.org },
          sessions: {
            copy: copy.map(function (x) { return x.name; }).sort(),
            skip: skip.slice().sort(function (a, b) { return a.file < b.file ? -1 : 1; }).map(function (s) { return { file: s.file, reason: s.reason }; }),
          },
          archived: addArchived.slice().sort(),
          presets: presetPlans.map(function (p) { return { scope: p.scope, status: p.status, reason: p.reason, add: p.added, skip: p.skipped }; }),
        };
        io.writeText(opts.planJson, JSON.stringify(planOut, null, 2));
      }

      var mergeScopes = presetPlans.filter(function (p) { return p.status === 'merge'; });
      if (!copy.length && !addArchived.length && !mergeScopes.length) { ui.say('沒有需要搬的東西，結束。', 'green'); return 0; }
      if (opts.dryRun) { ui.say('試跑模式：沒有寫入任何東西。', 'cyan'); return 0; }
      if (ui.ask('開始寫入？[Y/N]（直接按 Enter＝Y）', ['Y', 'N'], 'Y', 'Y') !== 'Y') throw new Error('CANCEL');

      // --- 備份 ---
      var mirrorPath = io.join(opts.appDataRoot, spec.presets.mirrorFile);
      backupDir = io.join(opts.backupRoot, io.timestamp());
      ui.step('備份', function () {
        io.mkdirp(backupDir);
        var manifest = { createdAt: new Date().toISOString(), sessionsDir: target.dir };
        io.copyTree(target.dir, io.join(backupDir, 'sessions'));
        if (mergeScopes.length) {
          io.copyTree(lsDir, io.join(backupDir, 'leveldb'));
          manifest.localStorageDir = lsDir;
          if (io.exists(mirrorPath)) { io.copyTree(mirrorPath, io.join(backupDir, 'mirror.json')); manifest.mirrorFile = mirrorPath; }
        }
        io.writeText(io.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      });
      ui.say('已備份到：' + backupDir, 'green');

      // --- 寫入 session ---
      var written = 0;
      copy.forEach(function (x) {
        var e = x.data;
        spec.sessions.dropKeys.forEach(function (k) { delete e[k]; });
        spec.sessions.nullKeys.forEach(function (k) { if (has(e, k)) e[k] = null; });
        Object.keys(replace).forEach(function (k) { if (has(e, k)) e[k] = replace[k]; });
        if (ui.step('寫入 session「' + titleOf(e) + '」', function () { io.writeText(io.join(target.dir, x.name), JSON.stringify(e)); })) written++;
      });
      if (addArchived.length) {
        ui.step('更新封存清單', function () {
          dstIdx.archived = arr(dstIdx.archived).concat(addArchived);
          io.writeText(idxDst, JSON.stringify(dstIdx));
        });
      }

      // --- 寫入環境 ---
      var envDone = [];
      mergeScopes.forEach(function (p) {
        var ok = ui.step('寫入' + p.label + '環境', function () {
          var key = makeKey(p.origin, p.dstName);
          lsAppend(io, lsDir, key, encodeValue(p.newJson));
          var got = lsRead(io, lsDir, p.dstName).entries[latin1(key)];
          if (!got || decodeValue(got.value) !== p.newJson) throw new Error('寫入後讀回的內容不一致');
        });
        if (ok) envDone.push(p);
      });
      var acctPlan = envDone.filter(function (p) { return p.scope === 'account'; })[0];
      if (acctPlan && io.exists(mirrorPath)) {
        ui.step('同步環境清單檔', function () {
          var mirror = JSON.parse(io.readText(mirrorPath));
          if (!mirror.byAccount) mirror.byAccount = {};
          if (!mirror.byAccount[target.account]) mirror.byAccount[target.account] = { presets: [] };
          mirror.byAccount[target.account].presets = acctPlan.presets;
          io.writeText(mirrorPath, JSON.stringify(mirror));
        });
      }

      ui.say('');
      ui.say('== 完成 ==', 'green');
      ui.say('側欄 session 寫入 ' + written + ' 筆；環境寫入 ' + envDone.length + ' 層。');
      ui.say('備份在：' + backupDir);
      ui.say('想還原的話：結束 app 後執行');
      ui.say('  ' + io.restoreCommand(backupDir), 'gray');
      if (!opts.noRelaunch && !opts.skipAppCheck) {
        if (ui.ask('要現在重新開啟 Claude 嗎？[Y/N]（直接按 Enter＝Y）', ['Y', 'N'], 'Y', 'N') === 'Y') {
          try { io.launchApp(); ui.say('已重新開啟 Claude。', 'green'); } catch (e) { ui.say('請自己打開 Claude。', 'yellow'); }
        }
      }
      return 0;
    } catch (e) {
      ui.say(e.message === 'CANCEL' ? '已取消。' : '發生錯誤：' + e.message, e.message === 'CANCEL' ? 'yellow' : 'red');
      if (backupDir) {
        ui.say('寫入可能只完成一部分。要回到遷移前的狀態，結束 app 後執行：', 'yellow');
        ui.say('  ' + io.restoreCommand(backupDir), 'gray');
      }
      return 1;
    }
  }

  function restore(io, opts, dir) {
    var ui = makeUi(io, opts);
    try {
      var mp = io.join(dir, 'manifest.json');
      if (!io.exists(mp)) throw new Error('這不是遷移備份資料夾（找不到 manifest.json）：' + dir);
      var m = JSON.parse(io.readText(mp));
      waitAppClosed(io, ui, opts);
      ui.say('從備份還原：' + dir);
      if (m.sessionsDir && io.exists(io.join(dir, 'sessions'))) {
        ui.step('還原 session 清單', function () {
          if (io.exists(m.sessionsDir)) io.removeTree(m.sessionsDir);
          io.copyTree(io.join(dir, 'sessions'), m.sessionsDir);
        });
      }
      if (m.mirrorFile && io.exists(io.join(dir, 'mirror.json'))) {
        ui.step('還原環境清單檔', function () {
          if (io.exists(m.mirrorFile)) io.removeTree(m.mirrorFile);
          io.copyTree(io.join(dir, 'mirror.json'), m.mirrorFile);
        });
      }
      if (m.localStorageDir && io.exists(io.join(dir, 'leveldb'))) {
        ui.step('還原 Local Storage', function () {
          io.listDir(m.localStorageDir).forEach(function (n) { io.removeTree(io.join(m.localStorageDir, n)); });
          io.listDir(io.join(dir, 'leveldb')).forEach(function (n) { io.copyTree(io.join(dir, 'leveldb', n), io.join(m.localStorageDir, n)); });
        });
      }
      ui.say('還原完成。', 'green');
      return 0;
    } catch (e) {
      ui.say(e.message === 'CANCEL' ? '已取消。' : '發生錯誤：' + e.message, 'red');
      return 1;
    }
  }

  return {
    migrate: migrate,
    restore: restore,
    leveldb: { read: lsRead, append: lsAppend, splitKey: splitKey, makeKey: makeKey, decodeValue: decodeValue, encodeValue: encodeValue },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CDM;
