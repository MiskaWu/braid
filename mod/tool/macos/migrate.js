// Claude desktop account migration - macOS entry point (JXA, built into every Mac).
//   osascript -l JavaScript migrate.js [--dry-run] [--yes] [--from ID] [--restore DIR]
//                                      [--projects all|none|DIR,DIR] [--presets all|none|folders|NAME,NAME]
// All logic and user-facing text live in core.js; this file only bridges files, the terminal
// and the app process through ObjC. Keep this file ASCII-only: osascript may not read it as UTF-8.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('stdlib');

var BUNDLE_ID_FALLBACK = 'com.anthropic.claudefordesktop';

function run(argv) {
  var fm = $.NSFileManager.defaultManager;
  var here = scriptDir(fm);

  function std(p) { return $(p).stringByStandardizingPath.js; }
  function join() {
    var parts = Array.prototype.slice.call(arguments);
    return parts.join('/').replace(/\/+/g, '/');
  }
  function readText(p) {
    var s = $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null);
    if (s.isNil()) throw new Error('cannot read ' + p);
    return s.js;
  }

  var CDM = eval(readText(join(here, 'core.js')) + '\n;CDM');
  var spec = JSON.parse(readText(std(join(here, '..', 'spec.json'))));
  var bundleId = (spec.app && spec.app.macBundleId) || BUNDLE_ID_FALLBACK;
  var home = $.NSHomeDirectory().js;

  function opt(name) { var i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
  var opts = {
    spec: spec,
    dryRun: argv.indexOf('--dry-run') >= 0,
    yes: argv.indexOf('--yes') >= 0,
    from: opt('--from'),
    appDataRoot: opt('--app-data-root') || join(home, 'Library', 'Application Support', 'Claude'),
    claudeHome: opt('--claude-home') || join(home, '.claude'),
    backupRoot: opt('--backup-root') || join(home, 'braid-backups'),
    planJson: opt('--plan-json'),
    skipAppCheck: argv.indexOf('--skip-app-check') >= 0,
    noRelaunch: argv.indexOf('--no-relaunch') >= 0,
    projects: opt('--projects'),
    presets: opt('--presets'),
    testPicks: envVar('BRAID_TEST_PICKS') ? envVar('BRAID_TEST_PICKS').split(';') : null,
  };

  var COLORS = { red: '31', green: '32', yellow: '33', cyan: '36', gray: '90' };
  function out(s) {
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
  }
  function assertOk(ok, what) { if (!ok) throw new Error(what); }

  var io = {
    interactive: true,
    say: function (msg, color) { out((COLORS[color] ? '\u001b[' + COLORS[color] + 'm' + msg + '\u001b[0m' : msg) + '\n'); },
    readLine: function (prompt) {
      out(prompt + ' ');
      var d = $.NSFileHandle.fileHandleWithStandardInput.availableData;
      if (d.length === 0) return '';
      return $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js;
    },
    join: join,
    readText: readText,
    writeText: function (p, s) {
      assertOk($(s).writeToFileAtomicallyEncodingError($(p), true, $.NSUTF8StringEncoding, null), 'cannot write ' + p);
    },
    readBytes: function (p) {
      var d = $.NSData.dataWithContentsOfFile($(p));
      if (d.isNil()) throw new Error('cannot read ' + p);
      return b64decode(d.base64EncodedStringWithOptions(0).js);
    },
    appendBytes: function (p, bytes) {
      var d = $.NSData.alloc.initWithBase64EncodedStringOptions($(b64encode(bytes)), 0);
      var h = $.NSFileHandle.fileHandleForWritingAtPath($(p));
      if (h.isNil()) throw new Error('cannot open for append ' + p);
      h.seekToEndOfFile;
      h.writeData(d);
      h.synchronizeFile;
      h.closeFile;
    },
    fileSize: function (p) { return ObjC.deepUnwrap(fm.attributesOfItemAtPathError($(p), null)).NSFileSize; },
    exists: function (p) { return fm.fileExistsAtPath($(p)); },
    isDir: function (p) { var r = Ref(); return fm.fileExistsAtPathIsDirectory($(p), r) && !!r[0]; },
    listDir: function (p) {
      var a = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError($(p), null));
      if (!a) throw new Error('cannot list ' + p);
      return a;
    },
    mkdirp: function (p) { assertOk(fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(p), true, $(), null), 'cannot create ' + p); },
    copyTree: function (s, d) { assertOk(fm.copyItemAtPathToPathError($(s), $(d), null), 'cannot copy ' + s); },
    removeTree: function (p) { if (fm.fileExistsAtPath($(p))) assertOk(fm.removeItemAtPathError($(p), null), 'cannot remove ' + p); },
    timestamp: function () {
      var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
      return '' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
    },
    isAppRunning: function () { return $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(bundleId)).count > 0; },
    // Same as choosing Quit in the app menu: the app saves its state before exiting.
    quitApp: function () {
      var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(bundleId));
      for (var i = 0; i < apps.count; i++) apps.objectAtIndex(i).terminate;
    },
    launchApp: function () {
      var app = Application.currentApplication();
      app.includeStandardAdditions = true;
      app.doShellScript('open -b ' + bundleId);
    },
    sleep: function (s) { delay(s); },
    // System checklist dialog (all items preselected). Returns 0-based indexes, or null when cancelled.
    chooseMany: function (title, labels) {
      var app = Application.currentApplication();
      app.includeStandardAdditions = true;
      var r = app.chooseFromList(labels, { withTitle: 'braid', withPrompt: title, multipleSelectionsAllowed: true, emptySelectionAllowed: true, defaultItems: labels });
      if (r === false) return null;
      return r.map(function (x) { return labels.indexOf(x); });
    },
    wslRoot: function () { return null; },
    restoreCommand: function (dir) { return 'osascript -l JavaScript "' + join(here, 'migrate.js') + '" --restore "' + dir + '"'; },
  };

  var code = opt('--restore') ? CDM.restore(io, opts, opt('--restore')) : CDM.migrate(io, opts);
  $.exit(code);
}

function envVar(name) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return v.isNil() ? null : v.js;
}

function scriptDir(fm) {
  var args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments);
  for (var i = 0; i < args.length; i++) {
    if (/migrate\.js$/.test(args[i])) {
      var p = args[i].charAt(0) === '/' ? args[i] : fm.currentDirectoryPath.js + '/' + args[i];
      return $(p).stringByStandardizingPath.stringByDeletingLastPathComponent.js;
    }
  }
  return fm.currentDirectoryPath.js;
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64decode(s) {
  var lookup = {};
  for (var i = 0; i < 64; i++) lookup[B64.charAt(i)] = i;
  s = s.replace(/[^A-Za-z0-9+/]/g, '');
  var outLen = Math.floor(s.length * 3 / 4), out = new Uint8Array(outLen), o = 0;
  for (var j = 0; j < s.length; j += 4) {
    var a = lookup[s.charAt(j)], b = lookup[s.charAt(j + 1)];
    var c = j + 2 < s.length ? lookup[s.charAt(j + 2)] : 0, d = j + 3 < s.length ? lookup[s.charAt(j + 3)] : 0;
    var n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < outLen) out[o++] = (n >>> 16) & 0xff;
    if (o < outLen) out[o++] = (n >>> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}
function b64encode(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) | (i + 2 < bytes.length ? bytes[i + 2] : 0);
    s += B64.charAt((n >>> 18) & 63) + B64.charAt((n >>> 12) & 63);
    s += i + 1 < bytes.length ? B64.charAt((n >>> 6) & 63) : '=';
    s += i + 2 < bytes.length ? B64.charAt(n & 63) : '=';
  }
  return s;
}
