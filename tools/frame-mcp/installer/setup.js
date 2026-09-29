#!/usr/bin/env node
/*
 * Holy Light画布 MCP 安装器
 * ================
 *
 * 解决的问题：`dist/frame-mcp.js` 打出来以后，要让 Codex / WorkBuddy 去拉起它，必须在它们的
 * 配置里写一条 **绝对路径**（被 spawn 的子进程没有 shell、也没有 PATH，写 `node` 三个字母一定
 * 是「命令找不到」）。而用户机器上 node.exe 在哪是无法预先知道的 —— 所以「安装」这件事本质上
 * 是 **到用户机器上把 node 找出来，再把找到的绝对路径写进配置**。这就是本文件全部的内容。
 *
 * 三件必须一起做、少一件就白装的事：
 *   1. 把 server bundle 拷到一个**稳定**的落点（默认 `%LOCALAPPDATA%\frame-mcp\`）。
 *      不能直接指着解压出来的目录 —— 用户解压完很可能顺手把文件夹删了，配置就断了。
 *   2. 找到 node ≥ 22.5 并且 `require('node:sqlite')` 真的能用（版本够了不代表这个内置模块在）。
 *   3. 写配置。**WorkBuddy 还额外要求写"信任"**：见下面 `writeWorkbuddy()` 的注释，
 *      只写 mcp.json 不写 mcp-approvals.json，server 会在 `buildDesiredConfigs` 里被静默跳过。
 *
 * 用法：
 *   node setup.js                     安装（默认装到所有检测到的客户端）
 *   node setup.js --target=workbuddy  只装 WorkBuddy
 *   node setup.js --check             只看现状，不写任何东西
 *   node setup.js --uninstall         把配置里 frame 那几条摘掉
 *   node setup.js --allow-generate    顺手放开"允许触发生成"（默认关闭，见 tools.ts 的双重锁）
 *
 * 这个文件刻意只用 CommonJS + ES2018 语法：它可能要跑在一个很老的 node 上（那时用户的 node
 * 还不够新，我们需要给出可读的提示，而不是先自己 SyntaxError 掉）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const SERVER_FILE = 'frame-mcp.js';
const MCP_NAME = 'frame';
const EXPECTED_TOOLS = 14;

/* ============================== 参数 ============================== */

function parseArgs(argv) {
  const opts = {
    uninstall: false,
    check: false,
    allowGenerate: false,
    selfTest: true,
    targets: null,
    dir: null,
    help: false,
  };
  for (const raw of argv) {
    const arg = String(raw || '');
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--allow-generate') opts.allowGenerate = true;
    else if (arg === '--no-selftest') opts.selfTest = false;
    else if (arg.indexOf('--target=') === 0) opts.targets = arg.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    else if (arg.indexOf('--dir=') === 0) opts.dir = arg.slice(6);
  }
  return opts;
}

/* ============================== 输出 ============================== */

function rule(ch) { return new Array(63).join(ch || '-'); }
function head(title) {
  console.log('\n' + rule('='));
  console.log(' ' + title);
  console.log(rule('='));
}
function ok(msg) { console.log('  [OK]   ' + msg); }
function warn(msg) { console.log('  [!!]   ' + msg); }
function info(msg) { console.log('         ' + msg); }

/* ============================== bundle 落点 ============================== */

/** 随包带来的 server bundle：优先压缩包里的 `server/`，开发态时从 `../dist/` 取。 */
function bundledServer() {
  const candidates = [
    path.join(__dirname, 'server', SERVER_FILE),
    path.join(__dirname, '..', 'dist', SERVER_FILE),
    path.join(__dirname, SERVER_FILE),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function defaultInstallDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'frame-mcp');
  }
  return path.join(os.homedir(), '.local', 'share', 'frame-mcp');
}

function installServer(src, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, SERVER_FILE);
  const srcSize = fs.statSync(src).size;
  const changed = !fs.existsSync(dest) || fs.statSync(dest).size !== srcSize;
  if (changed) fs.copyFileSync(src, dest);
  return { dest: dest, size: fs.statSync(dest).size, changed: changed };
}

/* ============================== 找 node ============================== */

function uniq(list) {
  const seen = {};
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(item);
  }
  return out;
}

function subDirs(parent) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory(); })
      .map(function (e) { return path.join(parent, e.name); });
  } catch (e) {
    return [];
  }
}

function nodeCandidates() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const list = [process.execPath];
  try {
    const r = spawnSync(win ? 'where' : 'which', ['node'], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0 && r.stdout) {
      for (const s of r.stdout.split(/\r?\n/)) list.push(s.trim());
    }
  } catch (e) { /* 没有 where/which 就算了 */ }

  if (win) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push(
      path.join(pf, 'nodejs', 'node.exe'),
      path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
      path.join(home, 'scoop', 'apps', 'nodejs', 'current', 'node.exe'),
    );
    /* WorkBuddy 自带的 node：装了 WorkBuddy 的人机器上就有，值得一试。 */
    const wb = path.join(home, '.workbuddy', 'binaries', 'node', 'versions');
    for (const d of subDirs(wb).sort().reverse()) list.push(path.join(d, 'node.exe'));
    const nvm = path.join(home, 'AppData', 'Roaming', 'nvm');
    for (const d of subDirs(nvm).sort().reverse()) list.push(path.join(d, 'node.exe'));
  } else {
    list.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node');
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    for (const d of subDirs(nvmRoot).sort().reverse()) list.push(path.join(d, 'bin', 'node'));
  }
  return uniq(list);
}

function versionToNumber(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '');
  if (!m) return 0;
  return Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]);
}

/**
 * 一个候选能不能用来跑 server。
 *
 * 判据不是版本号，而是 **真的 `require('node:sqlite')` 一下**：`store-sqlite.ts` 用的是这个
 * 内置模块，某些发行版（或 < 22.5 的 node）上它根本不存在，而它不存在时的症状是运行时抛错，
 * 比「版本不够」难排查得多。
 */
function probeNode(exe) {
  try {
    const r = spawnSync(exe, ['-e', "process.stdout.write(process.versions.node);require('node:sqlite');"], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const version = String(r.stdout || '').trim();
    if (r.status !== 0) {
      return { ok: false, version: version || null, reason: (r.stderr || '').split('\n')[0] };
    }
    return { ok: Boolean(version), version: version || null };
  } catch (e) {
    return { ok: false, version: null, reason: e && e.message ? e.message : String(e) };
  }
}

function findNode() {
  const tried = [];
  let best = null;
  for (const exe of nodeCandidates()) {
    if (!fs.existsSync(exe)) continue;
    const r = probeNode(exe);
    tried.push({ exe: exe, version: r.version, ok: r.ok });
    if (!r.ok) continue;
    if (!best || versionToNumber(r.version) > versionToNumber(best.version)) best = { exe: exe, version: r.version };
  }
  return { best: best, tried: tried };
}

/* ============================== 通用文件读写 ============================== */

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function stamp() {
  const d = new Date();
  const pad = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/** 写文件 + 顺手留一份带时间戳的备份。改别人的配置文件不留后路是不负责任的。 */
function writeWithBackup(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    backup = file + '.bak-' + stamp();
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, text, 'utf8');
  return backup;
}

function writeJson(file, value) {
  return writeWithBackup(file, JSON.stringify(value, null, 2) + '\n');
}

/* ============================== 客户端: WorkBuddy ============================== */

/** WorkBuddy 算 server 指纹的公式（与 ConnectorService.calculateConfigHash 逐字一致）。 */
function configHash(entry) {
  let input;
  if (entry.command) {
    input = (entry.command || '') + '|' +
      (entry.args || []).map(String).sort().join(',') + '|' +
      Object.keys(entry.env || {}).sort().join(',');
  } else if (entry.url) {
    input = entry.url;
  } else {
    input = JSON.stringify(entry);
  }
  return crypto.createHash('sha256').update(input).digest('hex');
}

/*
 * 配置文件：`~/.workbuddy/mcp.json`（不存在就新建，daemon 每次读 `.mcpServers`）。
 *
 * ⚠️ **必须同时写 `~/.workbuddy/mcp-approvals.json`**，否则这条配置等于没写：
 * daemon 在 `buildDesiredConfigs()` 里对每个自定义 server 调 `isUserServerApproved()`，
 * 不在批准表里就 `continue` 跳过 —— 不报错，日志里只有一行 `skipping untrusted server`。
 *
 * 批准表的 key 是 `sha256(command|args排序拼接|env的key排序拼接)::名字`，
 * 所以 **改了 args 或 env 的键名，指纹就变了，就得重新批准**（下面顺手清掉旧指纹）。
 */
function writeWorkbuddy(entry, uninstall) {
  const home = os.homedir();
  const wbDir = path.join(home, '.workbuddy');
  const mcpJson = path.join(wbDir, 'mcp.json');
  const approvalsJson = path.join(wbDir, 'mcp-approvals.json');

  if (!fs.existsSync(wbDir)) {
    warn('没找到 ~/.workbuddy，跳过 WorkBuddy（这台机器上没用过它？）');
    return false;
  }

  const cfg = readJson(mcpJson, { mcpServers: {} });
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};

  /* --- 批准表：先把 frame 的旧指纹全清掉（不管这次是装还是卸） --- */
  const ap = readJson(approvalsJson, {});
  const oldKeys = Object.keys(ap).filter(function (k) { return k.slice(-MCP_NAME.length - 2) === '::' + MCP_NAME; });
  for (const k of oldKeys) delete ap[k];

  if (uninstall) {
    if (!cfg.mcpServers[MCP_NAME]) {
      info('WorkBuddy：mcp.json 里本来就没有 frame');
    } else {
      delete cfg.mcpServers[MCP_NAME];
      const b = writeJson(mcpJson, cfg);
      ok('WorkBuddy：已从 mcp.json 移除 frame' + (b ? '（备份 ' + path.basename(b) + '）' : ''));
    }
    if (oldKeys.length) {
      writeJson(approvalsJson, ap);
      ok('WorkBuddy：已清掉 ' + oldKeys.length + ' 条 frame 信任记录');
    }
    return true;
  }

  cfg.mcpServers[MCP_NAME] = entry;
  const b1 = writeJson(mcpJson, cfg);
  const hash = configHash(entry);
  ap[hash + '::' + MCP_NAME] = Date.now();
  writeJson(approvalsJson, ap);

  ok('WorkBuddy：已写入 ~/.workbuddy/mcp.json' + (b1 ? '（备份 ' + path.basename(b1) + '）' : ''));
  info('并自动授予信任 —— 等同于你在「连接器管理」里点一次「信任」。指纹 ' + hash.slice(0, 12) + '…');
  return true;
}

/* ============================== 客户端: Codex ============================== */

/*
 * 配置文件：`~/.codex/config.toml`。手写一个最小化的区块删除：按表头定位，删到下一个表头。
 * 不引三方 toml 库 —— 装之前这台机器上有什么包是不知道的。
 */
function stripTomlSection(text, header) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const l of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(l)) {
      skipping = l.trim().slice(1, -1).trim() === header;
      if (skipping) continue;
    }
    if (!skipping) out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
}

function writeCodex(entry, uninstall) {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(file)) {
    if (!uninstall) warn('没找到 ~/.codex/config.toml，跳过 Codex（没装过 Codex 就忽略这条）');
    return false;
  }
  let text = fs.readFileSync(file, 'utf8');
  const had = text.indexOf('mcp_servers.' + MCP_NAME + ']') >= 0;
  /* 先删 .env 子表再删主表，反过来会把 .env 表头留在文件里。 */
  text = stripTomlSection(text, 'mcp_servers.' + MCP_NAME + '.env');
  text = stripTomlSection(text, 'mcp_servers.' + MCP_NAME);

  if (!uninstall) {
    /* TOML 的**单引号**是字面量字符串：Windows 路径里的 `\` 不会被当转义。 */
    const q = function (s) { return "'" + String(s).replace(/'/g, "\\'") + "'"; };
    text = text + [
      '',
      '[mcp_servers.' + MCP_NAME + ']',
      'type = "stdio"',
      'command = ' + q(entry.command),
      'args = [' + entry.args.map(q).join(', ') + ']',
      'startup_timeout_sec = 60',
      '',
      '[mcp_servers.' + MCP_NAME + '.env]',
      'HOLYLIGHT_MCP_ALLOW_GENERATE = "' + (entry.env.HOLYLIGHT_MCP_ALLOW_GENERATE || '0') + '"',
      '',
    ].join('\n');
  } else if (!had) {
    info('Codex：config.toml 里本来就没有 frame');
    return true;
  }

  const b = writeWithBackup(file, text);
  ok('Codex：' + (uninstall ? '已从 config.toml 移除 frame' : '已写入 config.toml') + (b ? '（备份 ' + path.basename(b) + '）' : ''));
  return true;
}

/* ============================== 客户端: Claude Desktop ============================== */

function claudeConfigPath() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/** 有 Claude 就顺手装上，没有就一个字都不说 —— 别拿不存在的东西打扰用户。 */
function writeClaude(entry, uninstall) {
  const file = claudeConfigPath();
  if (!fs.existsSync(file) && !fs.existsSync(path.dirname(file))) return false;
  const cfg = readJson(file, { mcpServers: {} });
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};

  if (uninstall) {
    if (!cfg.mcpServers[MCP_NAME]) return false;
    delete cfg.mcpServers[MCP_NAME];
    writeJson(file, cfg);
    ok('Claude Desktop：已移除 frame');
    return true;
  }
  cfg.mcpServers[MCP_NAME] = { command: entry.command, args: entry.args, env: entry.env };
  writeJson(file, cfg);
  ok('Claude Desktop：已写入 ' + file);
  return true;
}

/* ============================== 自检 ============================== */

/**
 * 真跑一遍 server：initialize → tools/list → tools/call frame_status。
 *
 * 顺带做「stdout 纯净度」检查：stdio 传输里 stdout 是协议通道，混进一行 npm 提示、
 * 一行 deprecation warning，客户端就再也解不开 JSON-RPC 了 —— 而报错点离真凶十万八千里。
 */
function selfTest(nodeExe, serverPath, env) {
  return new Promise(function (resolve) {
    const result = { ok: false, tools: [], status: '', impurity: [], error: '' };
    let child;
    try {
      /* env 必须是**要写进配置的那份**：否则验的是另一套开关，放行与否都可能不对应。 */
      child = spawn(nodeExe, [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: Object.assign({}, process.env, env || {}),
      });
    } catch (e) {
      result.error = 'spawn 失败：' + (e && e.message);
      return resolve(result);
    }

    let buf = '';
    let tail3 = [];
    let step = 0;
    let done = false;
    const timer = setTimeout(function () { finish('等了 30 秒还没走完握手'); }, 30000);

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) { /* 已经没了 */ }
      result.error = err || '';
      result.ok = !err && step >= 3 && result.tools.length >= EXPECTED_TOOLS && result.impurity.length === 0;
      resolve(result);
    }

    function send(obj) {
      try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { finish('写 stdin 失败'); }
    }

    function handle(str) {
      let msg = null;
      try { msg = JSON.parse(str); } catch (e) { result.impurity.push(str.slice(0, 120)); return; }
      if (!msg || msg.jsonrpc !== '2.0') { result.impurity.push(str.slice(0, 120)); return; }
      if (msg.id === 1) {
        step = 1;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else if (msg.id === 2) {
        step = 2;
        result.tools = ((msg.result && msg.result.tools) || []).map(function (t) { return t.name; });
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'frame_status', arguments: {} } });
      } else if (msg.id === 3) {
        step = 3;
        result.status = ((msg.result && msg.result.content) || []).map(function (c) { return String(c.text || ''); }).join('\n');
        finish(null);
      }
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', function (chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    });
    child.stderr.on('data', function (c) {
      const parts = String(c).split('\n').filter(Boolean);
      tail3 = tail3.concat(parts).slice(-3);
    });
    child.on('error', function (e) { finish('进程错误：' + (e && e.message)); });
    child.on('exit', function (code) {
      if (done) return;
      finish(step >= 3 ? null : '进程提前退出，code=' + code + (tail3.length ? '\n' + tail3.join('\n') : ''));
    });

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'frame-mcp-setup', version: '1.0.0' } },
    });
  });
}

/* ============================== 主流程 ============================== */

function mcpEntry(nodeExe, serverPath, allowGenerate) {
  return {
    command: nodeExe,
    args: [serverPath],
    type: 'stdio',
    env: { HOLYLIGHT_MCP_ALLOW_GENERATE: allowGenerate ? '1' : '0' },
    timeout: 120000,
    description: 'Holy Light画布画布读写：项目 / 节点 / 连线 / 工作流 / 任务',
    disabled: false,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log([
      '',
      'Holy Light画布 MCP 安装器',
      '',
      '  node setup.js                     安装到所有检测到的客户端',
      '  node setup.js --target=workbuddy  只装 WorkBuddy（可选 codex / claude，逗号分隔）',
      '  node setup.js --check             只看现状，不动任何文件',
      '  node setup.js --uninstall         摘掉配置里的 frame',
      '  node setup.js --allow-generate    放开「允许触发生成」（默认关闭）',
      '',
    ].join('\n'));
    return 0;
  }

  head(opts.check ? 'Holy Light画布 MCP · 现状检查' : (opts.uninstall ? 'Holy Light画布 MCP · 卸载' : 'Holy Light画布 MCP · 安装'));

  const serverSrc = bundledServer();
  if (!serverSrc) {
    warn('找不到 ' + SERVER_FILE + ' —— setup.js 应该和它在同一个包里（server/ 或 ../dist/）。');
    return 1;
  }
  info('随包 server：' + serverSrc);

  const installDir = opts.dir ? path.resolve(opts.dir) : defaultInstallDir();

  /* ---------- 1. node ---------- */
  head('1/4 找 node（要 ≥ 22.5 且 require("node:sqlite") 真的能用）');
  const found = findNode();
  if (!found.best) {
    warn('本机没有一个能用的 node。');
    for (const t of found.tried) info((t.ok ? '可用 ' : '不行 ') + (t.version || '?') + '   ' + t.exe);
    console.log('\n  请到 https://nodejs.org/ 装一个 LTS（≥ 22.5），然后重新双击 install.cmd。\n');
    return 1;
  }
  ok('选中 ' + found.best.exe);
  info('版本 ' + found.best.version);
  if (found.tried.filter(function (t) { return !t.ok; }).length) {
    info('另有 ' + found.tried.filter(function (t) { return !t.ok; }).length + ' 个 node 被判为不可用（多为版本过旧 / 缺 node:sqlite）');
  }

  /* ---------- 2. 落盘 ---------- */
  head('2/4 把 server 放到一个不会随手被删掉的位置');
  let serverPath;
  if (opts.check) {
    info('（--check 模式，不落盘）目标目录会是：' + installDir);
    serverPath = path.join(installDir, SERVER_FILE);
  } else {
    const r = installServer(serverSrc, installDir);
    ok((r.changed ? '已写入 ' : '已是最新 ') + r.dest);
    info((r.size / 1024 / 1024).toFixed(1) + ' MB —— 解压出来的那个文件夹现在可以删了');
    serverPath = r.dest;
    /*
     * 顺手把自己也留在那儿：这样以后「跑一次 --allow-generate / --uninstall」不需要
     * 再去翻当初解压的文件夹（那个文件夹大概率已经被删了）。
     */
    try {
      fs.copyFileSync(__filename, path.join(installDir, 'setup.js'));
    } catch (e) {
      info('（没能顺手留下 setup.js，不影响 MCP 本身）');
    }
  }

  const entry = mcpEntry(found.best.exe, serverPath, opts.allowGenerate);

  /* ---------- 3. 配置 ---------- */
  head('3/4 写客户端配置');
  const want = function (name) { return !opts.targets || opts.targets.indexOf(name) >= 0; };

  if (opts.check) {
    const wb = readJson(path.join(os.homedir(), '.workbuddy', 'mcp.json'), {});
    const cxFile = path.join(os.homedir(), '.codex', 'config.toml');
    const cd = readJson(claudeConfigPath(), {});
    info('WorkBuddy  ' + (((wb.mcpServers || {})[MCP_NAME]) ? '已配置' : '没有 frame'));
    info('Codex      ' + (fs.existsSync(cxFile) && fs.readFileSync(cxFile, 'utf8').indexOf('mcp_servers.' + MCP_NAME + ']') >= 0 ? '已配置' : '没有 frame'));
    info('Claude     ' + (((cd.mcpServers || {})[MCP_NAME]) ? '已配置' : '没有 frame'));
  } else if (opts.uninstall) {
    if (want('workbuddy')) writeWorkbuddy(entry, true);
    if (want('codex')) writeCodex(entry, true);
    if (want('claude')) writeClaude(entry, true);
  } else {
    if (want('workbuddy')) writeWorkbuddy(entry, false);
    if (want('codex')) writeCodex(entry, false);
    if (want('claude')) writeClaude(entry, false);
  }

  /* ---------- 4. 自检 ---------- */
  head('4/4 自检（真把它拉起来跑一遍）');
  if (opts.check || opts.uninstall) {
    info('跳过');
  } else if (!opts.selfTest) {
    info('按 --no-selftest 跳过');
  } else {
    const r = await selfTest(found.best.exe, serverPath, entry.env);
    if (r.tools.length) ok('握手成功，暴露 ' + r.tools.length + ' 个工具');
    if (r.tools.length && r.tools.length < EXPECTED_TOOLS) warn('工具数不到 ' + EXPECTED_TOOLS + '，bundle 可能不完整');
    if (r.status) {
      for (const l of r.status.split('\n').filter(Boolean).slice(0, 5)) info(l.replace(/\s+/g, ' ').trim());
    }
    if (r.impurity.length) {
      warn('stdout 混进了非协议输出（客户端会解不开 JSON-RPC）：');
      for (const l of r.impurity.slice(0, 5)) info(l);
    }
    if (r.error) warn(r.error);
    if (!r.ok) return 1;
  }

  console.log('\n' + rule('='));
  if (opts.check) {
    console.log(' 检查结束。');
  } else if (opts.uninstall) {
    console.log(' 已卸载。重启客户端后生效。');
  } else {
    console.log(' 装好了。');
    console.log('');
    console.log(' 接下来一定要做：**完全退出 WorkBuddy / Codex 再重新打开。**');
    console.log('');
    console.log('   为什么非重启不可：安装器已经帮你在 mcp-approvals.json 里授信了，');
    console.log('   但 daemon 的批准表是**每个进程只读一次**的 —— 已经在跑的那个进程');
    console.log('   看不到刚才写进去的那条，日志里会一直刷 skipping untrusted server。');
    console.log('   重启之后它才会读到，UI 上也会变成「已连接」。');
    console.log('');
    console.log(' 之后在对话里直接说「看看 Holy Light画布里有哪些项目」，它就会自动调这套工具。');
    console.log('');
    console.log(' 默认**不允许**触发真正花钱的生成任务。要放开的话重跑一次：');
    console.log('   node "' + path.join(installDir, 'setup.js') + '" --allow-generate');
    console.log(' （上面这句要能跑，需要把 setup.js 也留在那个目录里；或者直接对着');
    console.log('  这个包再跑一次 node setup.js --allow-generate。）');
  }
  console.log(rule('=') + '\n');
  return 0;
}

main().then(function (code) { process.exit(code); }).catch(function (e) {
  console.error('\n安装器炸了：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
