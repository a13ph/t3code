// t3-keeper: owns child processes (such as `claude`) for clients that
// may die and come back. Each child's stdout is kept as numbered lines, so a
// new client can attach and replay from the last line it saw.
//
// Protocol: newline-delimited JSON over a unix socket.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { LineSplitter, frame } from './lines.mjs';

export const PROTOCOL_VERSION = 1;

const DEFAULTS = {
  maxStdoutBytes: 32 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  eofGraceMs: 2000,
  termGraceMs: 5000,
  exitedTtlMs: 60 * 60 * 1000,
  stdoutDrainMs: 2000,
  // what happens to a live child with no client: 'hold' keeps it for a
  // reattach; 'drain' lets it finish the turn it is in, then closes it
  orphans: 'hold',
  orphanMaxMs: 15 * 60 * 1000,
  // drain: how long a spawn waits for an orphan of the same name before
  // closing it. As long as orphanMaxMs, so a resumed chat never cuts the
  // turn its old claude is still finishing; SDK 0.3.276 waited 75 s for a
  // spawn without giving up.
  spawnWaitMs: 15 * 60 * 1000,
};

const ALLOWED_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);

export function defaultSocketPath() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) throw new Error('XDG_RUNTIME_DIR is not set; pass a socket path');
  return path.join(runtime, 't3-keeper', 'keeper.sock');
}

function defaultLog(level, msg) {
  process.stderr.write(`${new Date().toISOString()} ${level} ${msg}\n`);
}

class Child {
  constructor(handle, name, argv, cwd) {
    this.handle = handle;
    this.name = name;
    this.argv = argv;
    this.cwd = cwd;
    this.proc = null;
    this.pid = null;
    this.created = new Date().toISOString();
    // stdout lines: lines[head + i] has number firstSeq + i
    this.lines = [];
    this.head = 0;
    this.firstSeq = 1;
    this.nextSeq = 1;
    this.bytes = 0;
    this.lostLines = 0;
    this.acked = 0;
    this.stderr = '';
    this.stderrDroppedBytes = 0;
    this.exitRaw = null;
    this.exit = null;
    this.stdoutEnded = false;
    this.conn = null;
    this.lastAttach = null;
    this.exitWaiters = [];
    this.ttlTimer = null;
    // turn state read off the stream-json traffic, for the drain
    this.stdinLines = null;
    this.turnOpen = false;
    this.pendingRequests = new Set();
    // null, 'draining', or 'closed: <why>'
    this.orphan = null;
    this.orphanTimer = null;
  }

  get alive() {
    return this.exit === null;
  }

  get bufferedLines() {
    return this.lines.length - this.head;
  }

  lineAt(seq) {
    return this.lines[this.head + (seq - this.firstSeq)];
  }

  dropOldest() {
    const line = this.lines[this.head];
    this.lines[this.head] = undefined;
    this.head += 1;
    this.firstSeq += 1;
    this.bytes -= Buffer.byteLength(line) + 1;
    if (this.head > 1024 && this.head * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }

  // Drops every line numbered <= upTo.
  trimThrough(upTo) {
    while (this.bufferedLines > 0 && this.firstSeq <= upTo) this.dropOldest();
  }

  describe() {
    return {
      handle: this.handle,
      name: this.name,
      pid: this.pid,
      alive: this.alive,
      exit: this.exit,
      first: this.firstSeq,
      last: this.nextSeq - 1,
      acked: this.acked,
      bufferedLines: this.bufferedLines,
      bufferedBytes: this.bytes,
      lostLines: this.lostLines,
      stderrBytes: Buffer.byteLength(this.stderr),
      attached: this.conn !== null,
      lastAttach: this.lastAttach,
      created: this.created,
      command: this.argv[0],
      cwd: this.cwd ?? null,
      turnOpen: this.turnOpen,
      pendingRequests: this.pendingRequests.size,
      orphan: this.orphan,
    };
  }
}

class Conn {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.attached = null;
    this.chain = Promise.resolve();
  }

  send(obj) {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(frame(obj));
  }
}

export async function startKeeper(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!['hold', 'drain'].includes(opts.orphans)) throw new Error(`orphans: ${opts.orphans} is not hold or drain`);
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const log = opts.log ?? defaultLog;
  const children = new Map();
  const conns = new Set();
  let connSeq = 0;
  let closing = null;

  await prepareSocketPath(socketPath);

  // ---- child lifecycle -------------------------------------------------

  function appendLine(rec, line) {
    const seq = rec.nextSeq;
    rec.nextSeq += 1;
    rec.lines.push(line);
    rec.bytes += Buffer.byteLength(line) + 1;
    // over the cap: the oldest lines go even though no client acked them;
    // a later attach from before them gets a `gap` event
    while (rec.bytes > opts.maxStdoutBytes && rec.bufferedLines > 1) {
      rec.lostLines += 1;
      rec.dropOldest();
    }
    if (rec.conn) rec.conn.send({ ev: 'out', handle: rec.handle, n: seq, line });
    noteStdout(rec, line);
  }

  // ---- turn state and the orphan drain ----------------------------------
  //
  // The keeper reads just enough of claude's stream-json to know whether a
  // child could still do something without a client: a turn is open from a
  // `user` message on stdin, or from the first line of a turn on stdout, to
  // a `result` line on stdout, and a `control_request` from the child (a
  // permission prompt, a hook) is pending until a `control_response` with
  // its request_id goes back. claude starts a turn with nothing on stdin for
  // a background task's wake.

  function noteStdout(rec, line) {
    const m = parseIfHas(line, '"result"');
    if (m?.type === 'result') {
      rec.turnOpen = false;
      checkOrphan(rec, 'turn ended');
      return;
    }
    if (!rec.turnOpen && opensTurn(line)) {
      rec.turnOpen = true;
      return;
    }
    const r = parseIfHas(line, '"control_request"');
    if (r?.type === 'control_request' && typeof r.request_id === 'string') {
      rec.pendingRequests.add(r.request_id);
      checkOrphan(rec, null);
      return;
    }
    const c = parseIfHas(line, '"control_cancel_request"');
    if (c?.type === 'control_cancel_request') rec.pendingRequests.delete(c.request_id);
  }

  function noteStdin(rec, line) {
    const m = parseIfHas(line, '"user"');
    if (m?.type === 'user') {
      rec.turnOpen = true;
      return;
    }
    const r = parseIfHas(line, '"control_response"');
    if (r?.type === 'control_response') rec.pendingRequests.delete(r.response?.request_id);
  }

  // A draining orphan is closed once nothing more can happen in it: no turn
  // open, or a control request that no client will ever answer.
  function checkOrphan(rec, idleWhy) {
    if (rec.orphan !== 'draining' || !rec.alive) return;
    if (rec.pendingRequests.size > 0) drainClose(rec, 'waits on a control request');
    else if (!rec.turnOpen && idleWhy) drainClose(rec, idleWhy);
  }

  function startDrain(rec) {
    if (opts.orphans !== 'drain' || !rec.alive || rec.orphan !== null) return;
    rec.orphan = 'draining';
    log('info', `orphan ${rec.handle} pid ${rec.pid}: turn open ${rec.turnOpen}, pending ${rec.pendingRequests.size}`);
    checkOrphan(rec, 'idle');
    if (rec.orphan === 'draining') {
      rec.orphanTimer = setTimeout(() => drainClose(rec, `turn ran past ${opts.orphanMaxMs} ms orphaned`), opts.orphanMaxMs);
      rec.orphanTimer.unref();
    }
  }

  function stopDrain(rec) {
    if (rec.orphan !== 'draining') return;
    rec.orphan = null;
    clearTimeout(rec.orphanTimer);
    log('info', `orphan ${rec.handle}: reattached, drain cancelled`);
  }

  function drainClose(rec, why) {
    if (rec.orphan?.startsWith('closed')) return waitExit(rec);
    rec.orphan = `closed: ${why}`;
    clearTimeout(rec.orphanTimer);
    log('info', `orphan ${rec.handle} pid ${rec.pid}: closing, ${why}`);
    return closeChild(rec, opts.eofGraceMs, opts.termGraceMs);
  }

  // drain: a spawn waits for every live, unattached child of the same name,
  // so a resumed chat never runs beside the claude it replaces
  async function waitForSameName(name) {
    if (opts.orphans !== 'drain' || name === null) return [];
    const olds = [...children.values()].filter((r) => r.name === name && r.alive && r.conn === null);
    return Promise.all(olds.map(async (r) => {
      const t0 = Date.now();
      log('info', `spawn ${name}: waiting for orphan ${r.handle} pid ${r.pid}`);
      if (await raceTimeout(waitExit(r), opts.spawnWaitMs) !== TIMEOUT) {
        return { handle: r.handle, how: 'exited', ms: Date.now() - t0 };
      }
      await drainClose(r, `a new spawn for ${name}`);
      return { handle: r.handle, how: `closed after ${opts.spawnWaitMs} ms`, ms: Date.now() - t0 };
    }));
  }

  function appendStderr(rec, text) {
    rec.stderr += text;
    const over = Buffer.byteLength(rec.stderr) - opts.maxStderrBytes;
    if (over > 0) {
      const buf = Buffer.from(rec.stderr);
      rec.stderr = buf.subarray(over).toString('utf8');
      rec.stderrDroppedBytes += over;
    }
    if (rec.conn) rec.conn.send({ ev: 'stderr', handle: rec.handle, data: text });
  }

  function finalizeExit(rec) {
    if (rec.exit !== null || rec.exitRaw === null) return;
    rec.exit = { ...rec.exitRaw, at: new Date().toISOString() };
    log('info', `exit ${rec.handle} pid ${rec.pid} code ${rec.exit.code} signal ${rec.exit.signal} lines ${rec.nextSeq - 1}`);
    if (rec.conn) rec.conn.send({ ev: 'exit', handle: rec.handle, code: rec.exit.code, signal: rec.exit.signal });
    clearTimeout(rec.orphanTimer);
    for (const w of rec.exitWaiters.splice(0)) w(rec.exit);
    scheduleTtl(rec);
  }

  function scheduleTtl(rec) {
    clearTimeout(rec.ttlTimer);
    if (rec.exit === null || rec.conn !== null) return;
    rec.ttlTimer = setTimeout(() => {
      if (rec.conn === null && children.get(rec.handle) === rec) {
        log('info', `forget ${rec.handle}: exited and unattached for ${opts.exitedTtlMs} ms`);
        children.delete(rec.handle);
      }
    }, opts.exitedTtlMs);
    rec.ttlTimer.unref();
  }

  function waitExit(rec) {
    if (rec.exit !== null) return Promise.resolve(rec.exit);
    return new Promise((resolve) => rec.exitWaiters.push(resolve));
  }

  function spawnChild(msg) {
    if (!Array.isArray(msg.argv) || msg.argv.length === 0 || !msg.argv.every((a) => typeof a === 'string')) {
      throw new Error('spawn: argv must be a non-empty array of strings');
    }
    const handle = 'k' + crypto.randomBytes(6).toString('hex');
    const rec = new Child(handle, typeof msg.name === 'string' ? msg.name : null, msg.argv, msg.cwd);
    const env = msg.env && typeof msg.env === 'object' ? cleanEnv(msg.env) : process.env;
    // group: the child leads a process group of its own, and what is left in
    // it gets SIGKILL once the child exits, as T3 0.1.0 does for the claude
    // it spawns itself
    const group = msg.group === true;
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(msg.argv[0], msg.argv.slice(1), {
          cwd: msg.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: group,
        });
      } catch (e) {
        reject(e);
        return;
      }
      rec.proc = proc;
      const out = new LineSplitter((line) => appendLine(rec, line));
      const err = new LineSplitter((line) => appendStderr(rec, line + '\n'));
      proc.stdout.on('data', (c) => out.push(c));
      proc.stdout.on('end', () => {
        out.end();
        rec.stdoutEnded = true;
        finalizeExit(rec);
      });
      proc.stderr.on('data', (c) => err.push(c));
      proc.stderr.on('end', () => err.end());
      proc.stdin.on('error', (e) => log('warn', `stdin ${handle}: ${e.code ?? e.message}`));
      proc.once('error', (e) => {
        if (rec.pid === null) {
          reject(e);
          return;
        }
        log('warn', `child error ${handle}: ${e.message}`);
      });
      proc.once('spawn', () => {
        rec.pid = proc.pid;
        children.set(handle, rec);
        log('info', `spawn ${handle} pid ${proc.pid} name ${rec.name} argv0 ${msg.argv[0]}`);
        resolve(rec);
      });
      proc.on('exit', (code, signal) => {
        rec.exitRaw = { code, signal };
        if (group) {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            // the group is already empty
          }
        }
        if (rec.stdoutEnded) finalizeExit(rec);
        else setTimeout(() => finalizeExit(rec), opts.stdoutDrainMs).unref();
      });
    });
  }

  function signalChild(rec, signal) {
    // Only a child of ours that has not been reaped: its pid cannot have
    // been reused yet.
    if (rec.exitRaw !== null || rec.proc.exitCode !== null || rec.proc.signalCode !== null) return false;
    log('info', `signal ${rec.handle} pid ${rec.pid} ${signal}`);
    return rec.proc.kill(signal);
  }

  async function closeChild(rec, eofGraceMs, termGraceMs) {
    if (rec.exit === null && rec.exitRaw === null) {
      if (!rec.proc.stdin.destroyed) rec.proc.stdin.end();
      const t1 = await raceTimeout(waitExit(rec), eofGraceMs);
      if (t1 === TIMEOUT) {
        signalChild(rec, 'SIGTERM');
        const t2 = await raceTimeout(waitExit(rec), termGraceMs);
        if (t2 === TIMEOUT) signalChild(rec, 'SIGKILL');
      }
    }
    return waitExit(rec);
  }

  // ---- attachment ------------------------------------------------------

  function detachConn(conn, reason) {
    const rec = conn.attached;
    if (!rec) return;
    conn.attached = null;
    if (rec.conn === conn) {
      rec.conn = null;
      log('info', `detach ${rec.handle} conn ${conn.id} (${reason}) alive ${rec.alive} last ${rec.nextSeq - 1}`);
      scheduleTtl(rec);
      startDrain(rec);
    }
  }

  function attach(conn, rec, after) {
    if (!Number.isInteger(after) || after < 0) throw new Error('attach: after must be an integer >= 0');
    const last = rec.nextSeq - 1;
    if (after > last) throw new Error(`attach: after ${after} is past the last line ${last}`);
    if (conn.attached && conn.attached !== rec) detachConn(conn, 'attach elsewhere');
    if (rec.conn && rec.conn !== conn) {
      const old = rec.conn;
      old.attached = null;
      old.send({ ev: 'detached', handle: rec.handle, reason: 'replaced' });
      old.socket.end();
      log('info', `attach ${rec.handle}: conn ${conn.id} replaces conn ${old.id}`);
    }
    rec.conn = conn;
    conn.attached = rec;
    clearTimeout(rec.ttlTimer);
    stopDrain(rec);
    rec.lastAttach = new Date().toISOString();
    // the client holds everything through `after`, so that is acked
    if (after > rec.acked) {
      rec.acked = after;
      rec.trimThrough(after);
    }
    log('info', `attach ${rec.handle} conn ${conn.id} after ${after} buffered ${rec.firstSeq}..${last}`);
    return { last };
  }

  function replay(conn, rec, after) {
    if (after + 1 < rec.firstSeq) {
      conn.send({ ev: 'gap', handle: rec.handle, from: after + 1, to: rec.firstSeq - 1 });
    }
    const from = Math.max(after + 1, rec.firstSeq);
    for (let n = from; n < rec.nextSeq; n++) conn.send({ ev: 'out', handle: rec.handle, n, line: rec.lineAt(n) });
    if (rec.exit !== null) conn.send({ ev: 'exit', handle: rec.handle, code: rec.exit.code, signal: rec.exit.signal });
  }

  function needAttached(conn) {
    if (!conn.attached) throw new Error('not attached to a handle');
    return conn.attached;
  }

  function lookup(handle) {
    const rec = children.get(handle);
    if (!rec) throw new Error(`no handle ${handle}`);
    return rec;
  }

  // ---- requests --------------------------------------------------------

  async function handle(conn, msg) {
    switch (msg.op) {
      case 'ping':
        return { pid: process.pid, protocol: PROTOCOL_VERSION, handles: children.size };
      case 'spawn': {
        if (closing) throw new Error('keeper is shutting down');
        const waitedFor = await waitForSameName(typeof msg.name === 'string' ? msg.name : null);
        if (closing) throw new Error('keeper is shutting down');
        // the client went away while the spawn waited (a second T3
        // restart): a child nobody talks to would only be drained again
        if (conn.socket.destroyed) throw new Error('client left while the spawn waited');
        const rec = await spawnChild(msg);
        if (msg.attach) {
          attach(conn, rec, 0);
          return { handle: rec.handle, pid: rec.pid, attached: true, after: 0, waitedFor, post: () => replay(conn, rec, 0) };
        }
        return { handle: rec.handle, pid: rec.pid, attached: false, waitedFor };
      }
      case 'attach': {
        const rec = lookup(msg.handle);
        const after = msg.after ?? 0;
        const { last } = attach(conn, rec, after);
        return {
          handle: rec.handle, pid: rec.pid, alive: rec.alive, first: rec.firstSeq, last, after,
          post: () => replay(conn, rec, after),
        };
      }
      case 'write': {
        const rec = needAttached(conn);
        if (typeof msg.data !== 'string') throw new Error('write: data must be a string');
        if (rec.exitRaw !== null || rec.proc.stdin.destroyed || rec.proc.stdin.writableEnded) {
          throw new Error('write: child stdin is closed');
        }
        rec.proc.stdin.write(msg.data);
        rec.stdinLines ??= new LineSplitter((line) => noteStdin(rec, line));
        rec.stdinLines.push(msg.data);
        return {};
      }
      case 'eof': {
        const rec = needAttached(conn);
        if (!rec.proc.stdin.destroyed) rec.proc.stdin.end();
        log('info', `eof ${rec.handle}`);
        return {};
      }
      case 'ack': {
        const rec = msg.handle ? lookup(msg.handle) : needAttached(conn);
        const after = msg.after;
        if (!Number.isInteger(after) || after < 0) throw new Error('ack: after must be an integer >= 0');
        if (after > rec.nextSeq - 1) throw new Error(`ack: after ${after} is past the last line ${rec.nextSeq - 1}`);
        if (after > rec.acked) {
          rec.acked = after;
          rec.trimThrough(after);
        }
        return { acked: rec.acked, first: rec.firstSeq };
      }
      case 'signal': {
        const rec = msg.handle ? lookup(msg.handle) : needAttached(conn);
        if (!ALLOWED_SIGNALS.has(msg.signal)) throw new Error(`signal: ${msg.signal} not allowed`);
        return { sent: signalChild(rec, msg.signal) };
      }
      case 'detach': {
        detachConn(conn, 'requested');
        return {};
      }
      case 'close': {
        const rec = msg.handle ? lookup(msg.handle) : needAttached(conn);
        const exit = await closeChild(rec, msg.eofGraceMs ?? opts.eofGraceMs, msg.termGraceMs ?? opts.termGraceMs);
        // the closer has the exit status: that acknowledges it
        if (rec.conn) detachConn(rec.conn, 'closed');
        children.delete(rec.handle);
        clearTimeout(rec.ttlTimer);
        return { exit };
      }
      case 'forget': {
        const rec = lookup(msg.handle);
        if (rec.alive) throw new Error(`forget: ${rec.handle} is still running; close it`);
        if (rec.conn) detachConn(rec.conn, 'forgotten');
        children.delete(rec.handle);
        clearTimeout(rec.ttlTimer);
        return {};
      }
      case 'list':
        return { handles: [...children.values()].map((r) => r.describe()) };
      case 'stderr': {
        const rec = lookup(msg.handle);
        return { data: rec.stderr, droppedBytes: rec.stderrDroppedBytes };
      }
      default:
        throw new Error(`unknown op ${msg.op}`);
    }
  }

  function onRequest(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      conn.send({ ok: false, error: 'bad json' });
      return;
    }
    if (msg === null || typeof msg !== 'object') {
      conn.send({ ok: false, error: 'request must be an object' });
      return;
    }
    // one connection's requests run in order: a write sent right after a
    // spawn must land on the child that spawn made
    conn.chain = conn.chain.then(async () => {
      try {
        const res = await handle(conn, msg);
        const post = res.post;
        delete res.post;
        conn.send({ id: msg.id, ok: true, ...res });
        if (post) post();
      } catch (e) {
        conn.send({ id: msg.id, ok: false, error: e.message, code: e.code });
      }
    });
  }

  const server = net.createServer((socket) => {
    const conn = new Conn(++connSeq, socket);
    conns.add(conn);
    const lines = new LineSplitter((raw) => {
      if (raw.length > 0) onRequest(conn, raw);
    });
    socket.on('data', (c) => lines.push(c));
    socket.on('error', (e) => log('warn', `conn ${conn.id}: ${e.code ?? e.message}`));
    socket.on('close', () => {
      conns.delete(conn);
      detachConn(conn, 'connection closed');
    });
  });

  const oldMask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(oldMask);
  }
  fs.chmodSync(socketPath, 0o600);
  log('info', `listening ${socketPath} pid ${process.pid}`);

  async function close({ closeChildren = true } = {}) {
    if (closing) return closing;
    closing = (async () => {
      server.close();
      for (const c of conns) c.socket.destroy();
      if (closeChildren) {
        await Promise.all([...children.values()].filter((r) => r.alive)
          .map((r) => closeChild(r, opts.eofGraceMs, opts.termGraceMs)));
      }
      for (const r of children.values()) clearTimeout(r.ttlTimer);
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // already gone
      }
      log('info', 'keeper closed');
    })();
    return closing;
  }

  return { socketPath, close, children };
}

const TIMEOUT = Symbol('timeout');
function raceTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// A turn's first lines on stdout: a system init (one per turn), from a CLI
// that sends them a command_lifecycle "started", and the turn's assistant
// lines. A command_lifecycle "completed" comes after the result and opens
// nothing.
function opensTurn(line) {
  const l = parseIfHas(line, '"command_lifecycle"');
  if (l?.type === 'command_lifecycle') return l.state === 'started';
  const m = parseIfHas(line, '"init"') ?? parseIfHas(line, '"assistant"');
  return (m?.type === 'system' && m.subtype === 'init') || m?.type === 'assistant';
}

// JSON.parse only for a line that contains `needle`: most of claude's lines
// are stream events the drain does not care about.
function parseIfHas(line, needle) {
  if (!line.includes(needle)) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

async function prepareSocketPath(socketPath) {
  const dir = path.dirname(socketPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  let st;
  try {
    st = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  const live = await new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
  if (live) throw new Error(`another keeper is listening on ${socketPath}`);
  fs.unlinkSync(socketPath);
}
