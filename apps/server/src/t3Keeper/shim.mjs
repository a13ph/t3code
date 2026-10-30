// Client side of t3-keeper, shaped as the Claude Agent SDK's
// `spawnClaudeCodeProcess` option.
//
//   spawnNew({socketPath, name, ...})          -> spawner: a new child in the keeper
//   attachExisting({socketPath, handle, after}) -> spawner: reattach to a live child
//
// A spawner is the function the SDK calls with its SpawnOptions; it returns
// a KeeperProcess, which has the SDK's SpawnedProcess shape. The same object
// is also at `spawner.process`, and `spawner.whenProcess` resolves to it.
//
// Detach versus close:
//   - the SDK's own close() ends stdin and later kills: that reaches the
//     keeper as `eof` then `signal`, and the child ends
//   - proc.detach() drops the socket and sends nothing; from then on stdin's
//     end and kill() are no-ops, so a q.close() after detach() leaves the
//     child running in the keeper
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { LineSplitter, frame } from './lines.mjs';

function keeperError(message, code, extra = {}) {
  const e = new Error(message);
  if (code) e.code = code;
  Object.assign(e, extra);
  return e;
}

export class KeeperProcess extends EventEmitter {
  // opts: socketPath, mode ('spawn'|'attach'), handle, after, name,
  //       onReady, onCursor, onStderr, onGap, autoAck, forgetOnExit
  constructor(opts, spawnOptions) {
    super();
    this.opts = opts;
    this.handle = opts.handle ?? null;
    this.pid = undefined;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.detached = false;
    this.cursor = opts.mode === 'attach' ? opts.after ?? 0 : 0;
    this._ids = 0;
    this._pending = new Map();
    this._finished = false;
    this._ackScheduled = false;

    // fallbackLocal: a child this process started itself because the
    // keeper could not be reached
    this.local = false;
    this._child = null;
    this._connected = false;
    // 'keeper' once the socket connects, 'local' after a fallback; stdin
    // waits for it, so writes made before the connect fails still reach
    // the child, in order
    this._route = new Promise((resolve) => {
      this._resolveRoute = resolve;
    });

    this.stdout = new PassThrough();
    const decoder = new StringDecoder('utf8');
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        const data = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (data.length === 0) return cb();
        this._route.then((route) => {
          if (route === 'local') {
            if (this._child.stdin.destroyed) return cb();
            this._child.stdin.write(data, () => cb());
            return;
          }
          // a write cut off by detach() is dropped quietly: the caller
          // chose to leave
          if (this.detached) return cb();
          this._request({ op: 'write', data }).then(
            (r) => cb(r.ok || this.detached ? undefined : keeperError(`keeper write: ${r.error}`, 'EKEEPERWRITE')),
            (e) => cb(this.detached ? undefined : e),
          );
        });
      },
      final: (cb) => {
        this._route.then((route) => {
          if (route === 'local') {
            this._child.stdin.end();
            return cb();
          }
          if (this.detached || this._finished) return cb();
          this._request({ op: 'eof' }).then(() => cb(), () => cb());
        });
      },
    });

    let readyResolve;
    let readyReject;
    this.ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    this.ready.catch(() => {});
    this._readyResolve = readyResolve;
    this._readyReject = readyReject;

    // connectRetryMs: an unreachable keeper (ENOENT, ECONNREFUSED) is tried
    // again until this deadline before the fallback or the error, so a
    // keeper that is restarting still gets the child
    this._connectDeadline = Date.now() + (opts.connectRetryMs ?? 0);
    this._connect(spawnOptions);
    // the SDK's abort ends a child it spawned itself; do the same here (a
    // local fallback child gets the signal from spawn())
    spawnOptions?.signal?.addEventListener('abort', () => {
      if (!this.local) this.kill('SIGTERM');
    }, { once: true });

    const first = opts.mode === 'spawn'
      ? {
        op: 'spawn', attach: true, name: opts.name, group: opts.group === true,
        argv: [spawnOptions.command, ...spawnOptions.args],
        cwd: spawnOptions.cwd, env: spawnOptions.env,
      }
      : { op: 'attach', handle: opts.handle, after: this.cursor };
    this._request(first).then((r) => {
      if (this.local) return;
      if (!r.ok) {
        const extra = opts.mode === 'spawn' ? { syscall: `spawn ${spawnOptions.command}` } : {};
        const e = keeperError(`keeper ${first.op}: ${r.error}`, r.code ?? 'EKEEPER', extra);
        readyReject(e);
        this._fail(e);
        return;
      }
      this.handle = r.handle;
      this.pid = r.pid;
      const info = { handle: r.handle, pid: r.pid, first: r.first, last: r.last, alive: r.alive ?? true };
      readyResolve(info);
      opts.onReady?.(info);
    }, (e) => {
      if (!this.local) readyReject(e);
    });
  }

  _connect(spawnOptions) {
    const opts = this.opts;
    const sock = net.createConnection(opts.socketPath);
    this._sock = sock;
    // requests made before the connect, sent again on a retried socket
    for (const p of this._pending.values()) sock.write(p.frame);
    const lines = new LineSplitter((raw) => raw && this._onFrame(JSON.parse(raw)));
    sock.on('data', (c) => lines.push(c));
    sock.on('connect', () => {
      this._connected = true;
      this._resolveRoute('keeper');
    });
    sock.on('error', (e) => {
      if (!this._connected && !this.detached && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')
          && Date.now() < this._connectDeadline) {
        sock.retried = true;
        setTimeout(() => this.detached || this._connect(spawnOptions), 200);
        return;
      }
      if (!this._connected && opts.mode === 'spawn' && opts.fallbackLocal) {
        this._spawnLocal(e, spawnOptions);
        return;
      }
      this._resolveRoute('keeper');
      this._readyReject(e);
      if (!this.detached && !this._finished) this._fail(e);
    });
    sock.on('close', () => {
      if (sock.retried) return;
      for (const p of this._pending.values()) p.reject(keeperError('keeper connection closed', 'EKEEPERLOST'));
      this._pending.clear();
      if (!this.local && !this.detached && !this._finished) {
        this._fail(keeperError('keeper connection lost before the child exited', 'EKEEPERLOST'));
      }
    });
  }

  // The keeper is unreachable: start the child here, as the SDK would have.
  // It dies with this process, like any child the SDK spawns itself.
  _spawnLocal(cause, spawnOptions) {
    this.local = true;
    this.opts.onFallback?.(cause);
    let child;
    try {
      child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ['pipe', 'pipe', 'pipe'],
        signal: spawnOptions.signal, detached: this.opts.group === true,
      });
      if (this.opts.group === true) {
        child.once('exit', () => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // the group is already empty
          }
        });
      }
    } catch (e) {
      this._readyReject(e);
      this._failLocal(e);
      return;
    }
    this._child = child;
    this._resolveRoute('local');
    child.stdout.pipe(this.stdout);
    child.stderr.on('data', (c) => this.opts.onStderr?.(c.toString('utf8')));
    child.stdin.on('error', () => {});
    child.once('spawn', () => {
      this.pid = child.pid;
      const info = { local: true, pid: child.pid };
      this._readyResolve(info);
      this.opts.onReady?.(info);
    });
    child.once('error', (e) => {
      if (this.pid === undefined) this._readyReject(e);
      this._failLocal(e);
    });
    // 'close' comes after stdout has ended, so the SDK has every line
    child.once('close', (code, signal) => {
      if (this._failed) return;
      this._finished = true;
      this.exitCode = code;
      this.signalCode = signal;
      this.emit('exit', code, signal);
    });
  }

  _failLocal(err) {
    if (this._failed) return;
    this._failed = true;
    this.stdout.end();
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  _request(msg) {
    const id = ++this._ids;
    return new Promise((resolve, reject) => {
      if (this._sock.destroyed) {
        reject(keeperError('keeper connection closed', 'EKEEPERLOST'));
        return;
      }
      const f = frame({ ...msg, id });
      this._pending.set(id, { resolve, reject, frame: f });
      this._sock.write(f);
    });
  }

  _onFrame(m) {
    if (m.id !== undefined) {
      const p = this._pending.get(m.id);
      if (p) {
        this._pending.delete(m.id);
        p.resolve(m);
      }
      return;
    }
    // frames already in flight after a failure, a detach or the exit are
    // dropped: stdout is ended by then
    if (this._failed || this.detached || this._finished) return;
    switch (m.ev) {
      case 'out':
        if (m.n !== this.cursor + 1) {
          // a replay that repeats or skips a line would hand the SDK a
          // control request twice or lose one: fail loudly
          this._fail(keeperError(`keeper sent line ${m.n}, expected ${this.cursor + 1}`, 'EKEEPERSEQ'));
          return;
        }
        this.cursor = m.n;
        this.stdout.write(m.line + '\n');
        this.opts.onCursor?.(m.n);
        if (this.opts.autoAck) this._scheduleAck();
        break;
      case 'stderr':
        this.opts.onStderr?.(m.data);
        break;
      case 'gap': {
        const info = { from: m.from, to: m.to };
        if (this.opts.onGap) {
          this.opts.onGap(info);
          this.cursor = m.to;
        } else {
          this._fail(keeperError(`keeper no longer holds lines ${m.from}..${m.to}`, 'EKEEPERGAP', info));
        }
        break;
      }
      case 'exit':
        this._finished = true;
        this.exitCode = m.code;
        this.signalCode = m.signal;
        this.stdout.end();
        if (this.opts.forgetOnExit !== false) {
          this._request({ op: 'forget', handle: this.handle }).catch(() => {}).finally(() => this._sock.end());
        }
        setImmediate(() => this.emit('exit', m.code, m.signal));
        break;
      case 'detached':
        // another client attached to this handle and took it over
        this.detached = true;
        this.stdout.end();
        this.emit('detached', m.reason);
        break;
      default:
        break;
    }
  }

  _fail(err) {
    if (this._failed) return;
    this._failed = true;
    this.stdout.end();
    this._sock.destroy();
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  _scheduleAck() {
    if (this._ackScheduled) return;
    this._ackScheduled = true;
    setImmediate(() => {
      this._ackScheduled = false;
      if (!this._sock.destroyed) this.ack(this.cursor);
    });
  }

  // Tells the keeper every line through `n` is safe with the caller, so it
  // may drop them. Call it after persisting the cursor.
  ack(n = this.cursor) {
    return this._request({ op: 'ack', after: n });
  }

  // Leaves the child running in the keeper: drops the connection without
  // an EOF. Returns what a later attachExisting() needs.
  detach() {
    // a local child cannot outlive this process; the SDK's close ends it
    if (this.local) return { handle: null, after: this.cursor };
    if (!this.detached) {
      this.detached = true;
      this._sock.destroy();
      this.stdout.end();
    }
    return { handle: this.handle, after: this.cursor };
  }

  kill(signal = 'SIGTERM') {
    if (this.local) {
      if (!this._child || this._finished) return false;
      this.killed = true;
      return this._child.kill(signal);
    }
    if (this.detached || this._finished || this._failed) return false;
    this.killed = true;
    this._request({ op: 'signal', signal }).catch(() => {});
    return true;
  }
}

function makeSpawner(opts) {
  let resolveProc;
  const spawner = (spawnOptions) => {
    const proc = new KeeperProcess(opts, spawnOptions);
    spawner.process = proc;
    resolveProc(proc);
    return proc;
  };
  spawner.process = null;
  spawner.whenProcess = new Promise((r) => {
    resolveProc = r;
  });
  return spawner;
}

// A spawner that starts a new child in the keeper with the SDK's argv, env
// and cwd. opts.name is a label shown by `list` (T3: the thread id).
export function spawnNew(opts) {
  if (!opts?.socketPath) throw new Error('spawnNew: socketPath is required');
  return makeSpawner({ ...opts, mode: 'spawn' });
}

// A spawner that ignores the SDK's argv and attaches to a live child.
// opts.after is the last line number the caller already delivered (its
// persisted cursor); the replay starts at the line after it.
export function attachExisting(opts) {
  if (!opts?.socketPath) throw new Error('attachExisting: socketPath is required');
  if (typeof opts.handle !== 'string') throw new Error('attachExisting: handle is required');
  if (!Number.isInteger(opts.after) || opts.after < 0) throw new Error('attachExisting: after must be an integer >= 0');
  return makeSpawner({ ...opts, mode: 'attach' });
}

// One request on a fresh connection: list, close, forget, stderr, ping.
export function request(socketPath, msg, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(keeperError(`keeper ${msg.op}: no reply in ${timeoutMs} ms`, 'ETIMEDOUT'));
    }, timeoutMs);
    const lines = new LineSplitter((raw) => {
      if (!raw) return;
      const m = JSON.parse(raw);
      if (m.id !== 1) return;
      clearTimeout(timer);
      sock.end();
      resolve(m);
    });
    sock.on('data', (c) => lines.push(c));
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.write(frame({ ...msg, id: 1 }));
  });
}
