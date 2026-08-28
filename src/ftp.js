/**
 * A small FTP / explicit-FTPS client, because there is no dependency to add.
 *
 * This exists for one job: put the folder `src/publish.js` builds onto a web
 * host that offers FTP and nothing else. It is not a general FTP library — no
 * listing, no download, no ASCII mode, no active mode — and it should stay that
 * way. Every command it speaks is one the publish path needs.
 *
 * SFTP is deliberately absent. SFTP is a subsystem of SSH, and implementing SSH
 * is not a weekend of `node:net`; it would mean a dependency, which this project
 * does not take. If a host offers only SFTP, that is a reason to reach for a
 * different transport, not to bend the rule.
 *
 * Upstream traps this handles, in the style of src/sources/*:
 *
 * - **Replies are multiline.** `230-Welcome` opens a block that ends only at a
 *   line beginning with the same code and a *space*. A parser that treats the
 *   first line as the whole reply works against one server and then reads the
 *   banner as the answer to USER against the next, and every command after that
 *   is answered by the one before it.
 * - **A data connection under FTPS must resume the control connection's TLS
 *   session.** vsftpd ships `require_ssl_reuse=YES` and ProFTPD has the same
 *   option; without the resumed session the transfer is refused with a bare
 *   `425` that says nothing about TLS. Hence `session: control.getSession()`.
 * - **PASV hands back the server's own idea of its address**, which behind NAT
 *   is a private one that nothing outside can reach. EPSV returns a port and
 *   nothing else, so it is tried first; when a server is too old for it, the
 *   PASV *port* is used with the address we already connected to, which is the
 *   same thing every modern client does.
 * - **A completed STOR is two events, not one.** The 226 on the control channel
 *   and the close of the data channel can arrive in either order, and treating
 *   whichever came first as "done" truncates files under load.
 * - **A reader can fetch a file mid-upload.** The remote has no backend to
 *   retry against — a half-written JSON is a parse error on somebody's phone —
 *   so every file lands as `.tmp` and is renamed into place.
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { posix } from 'node:path';

/** Positive-completion codes this client treats as success, per command. Every
 *  other reply is an error carrying the server's own words, which are usually
 *  more useful than anything we could write here. */
const ok = (reply, ...codes) => {
  if (!codes.includes(reply.code)) {
    throw new Error(`FTP ${reply.code}: ${reply.text.split('\n')[0]}`);
  }
  return reply;
};

export function createFtp(opts = {}) {
  const host = opts.host;
  const port = Number(opts.port) || 21;
  const timeout = (Number(opts.timeoutSeconds) || 60) * 1000;
  const secure = opts.secure !== false;
  const reject = opts.allowSelfSigned !== true;

  let control = null;          // the live control socket (plain, then TLS)
  let session = null;          // control's TLS session, for the data channels
  let usePasv = false;         // set once EPSV has been refused
  const made = new Set();      // directories already created this session

  /* ---------- the control channel ---------- */

  // One command in flight at a time. FTP has no request ids: a reply belongs to
  // whatever was asked last, so pipelining would mean guessing.
  let waiting = null;
  const queue = [];
  let lines = [], block = null;

  const deliver = (err, reply) => {
    const w = waiting;
    waiting = null;
    if (!w) return;
    err ? w.reject(err) : w.resolve(reply);
  };

  function onLine(line) {
    lines.push(line);
    const m = /^(\d{3})([ -])/.exec(line);
    if (block === null) {
      if (!m) return;                       // continuation before a code: keep reading
      if (m[2] === '-') { block = m[1]; return; }
    } else if (!line.startsWith(`${block} `)) {
      return;                               // still inside the block
    }
    const code = Number(block ?? m[1]);
    const text = lines.join('\n');
    lines = []; block = null;
    if (waiting) deliver(null, { code, text });
    else queue.push({ code, text });        // the greeting, or an unasked-for 421
  }

  /** The next reply, whether it has already arrived or not. A STOR produces
   *  two — the 150 that opens the transfer and the 226 that closes it — and the
   *  second is read with this. */
  const reply = () => new Promise((resolve, rej) => {
    if (queue.length) return resolve(queue.shift());
    waiting = { resolve, reject: rej };
  });

  function send(cmd) {
    // Passwords are the one thing that must not reach a log, and this module
    // hands its errors to a job log that the dashboard shows.
    if (!control) throw new Error('not connected');
    control.write(`${cmd}\r\n`);
    return reply();
  }

  function attach(socket) {
    let buf = '';
    // latin1, not utf8: replies are ASCII and a chunk boundary in the middle of
    // a multi-byte sequence would otherwise become a replacement character and
    // corrupt a path in an error message.
    socket.on('data', d => {
      buf += d.toString('latin1');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    });
    socket.on('error', e => deliver(e));
    socket.on('close', () => deliver(new Error('the server closed the connection')));
    socket.setTimeout(timeout, () => {
      socket.destroy();
      deliver(new Error(`no reply from ${host} in ${Math.round(timeout / 1000)}s`));
    });
  }

  /**
   * Connect, with a timeout that stops applying the moment it is connected.
   *
   * The connect timeout has to be taken back off: left in place it fires later
   * against an idle-but-healthy socket — the control channel is silent for the
   * whole of a transfer — and destroys a connection that is working.
   */
  const open = (options, tls = false) => new Promise((resolve, rej) => {
    const settle = () => {
      s.setTimeout(0);
      s.off('error', rej);
      resolve(s);
    };
    const s = tls ? tlsConnect(options, settle) : netConnect(options, settle);
    s.setTimeout(timeout, () => {
      s.destroy();
      rej(new Error(`could not reach ${host}:${options.port ?? port} in ${Math.round(timeout / 1000)}s`));
    });
    s.once('error', rej);
  });

  /* ---------- the data channel ---------- */

  async function openData() {
    let dataPort;
    if (!usePasv) {
      const r = await send('EPSV');
      if (r.code === 229) {
        // 229 Entering Extended Passive Mode (|||51234|)
        const m = /\(([\s\S])\1\1(\d+)\1\)/.exec(r.text);
        if (!m) throw new Error(`could not read the port out of: ${r.text}`);
        dataPort = Number(m[2]);
      } else {
        usePasv = true;                     // too old for EPSV; do not ask again
      }
    }
    if (dataPort === undefined) {
      const r = ok(await send('PASV'), 227);
      const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
      if (!m) throw new Error(`could not read the port out of: ${r.text}`);
      dataPort = Number(m[5]) * 256 + Number(m[6]);
      // The four address octets in the reply are deliberately ignored — see the
      // NAT note at the top. We already have an address that reaches this server.
    }

    const raw = await open({ host, port: dataPort });
    if (!secure) return raw;
    return open({
      socket: raw, servername: host, rejectUnauthorized: reject,
      // The whole point: resume the control connection's session, or a server
      // configured to require it refuses the transfer.
      session,
    }, true);
  }

  /* ---------- the API ---------- */

  async function connect() {
    if (!host) throw new Error('publish.ftp.host is not set');
    control = await open({ host, port });
    attach(control);
    ok(await reply(), 220);                 // the greeting is unsolicited

    if (secure) {
      ok(await send('AUTH TLS'), 234);
      // The plain socket becomes the TLS socket's transport. Its listeners and
      // its idle timer have to come off first, or the raw socket keeps reading
      // ciphertext as if it were replies and times out under its own clock.
      const plain = control;
      plain.removeAllListeners('data');
      plain.removeAllListeners('close');
      plain.removeAllListeners('error');
      plain.setTimeout(0);
      control = await open({ socket: plain, servername: host, rejectUnauthorized: reject }, true);
      // Capture the session both ways. Under TLS 1.2 it exists the moment the
      // handshake finishes; under TLS 1.3 the ticket is sent *after*, so
      // getSession() here returns null and only the 'session' event has it.
      // Reading it one way and one way only is how the data channel ends up
      // unable to resume against a server that insists on it.
      session = control.getSession();
      control.on('session', s => { session = s; });
      attach(control);
      ok(await send('PBSZ 0'), 200);
      ok(await send('PROT P'), 200);
    }

    // 331 is "password required", which is the normal answer to USER. A server
    // with an open account answers 230 and there is nothing left to send.
    const u = await send(`USER ${opts.user ?? 'anonymous'}`);
    if (u.code === 331) ok(await send(`PASS ${opts.password ?? ''}`), 230, 202);
    else ok(u, 230, 202);

    ok(await send('TYPE I'), 200);
    if (opts.dir) await cwd(opts.dir);
  }

  /** Change into a directory, making it — and its parents — if it is not there.
   *  A fresh account often has nothing but the document root. */
  async function cwd(dir) {
    const r = await send(`CWD ${dir}`);
    if (r.code === 250) return;
    let path = dir.startsWith('/') ? '' : null;
    for (const part of dir.split('/').filter(Boolean)) {
      path = path === null ? part : `${path}/${part}`;
      await send(`MKD ${path}`);            // 550 here means "already there"
    }
    ok(await send(`CWD ${dir}`), 250);
  }

  /** Create the directory a file is about to land in. Directories are made one
   *  level at a time because MKD is specified for a single directory, and the
   *  servers that accept a whole path are the exception rather than the rule. */
  async function ensureDir(dir) {
    if (!dir || dir === '.' || made.has(dir)) return;
    let path = '';
    for (const part of dir.split('/').filter(Boolean)) {
      path = path ? `${path}/${part}` : part;
      if (made.has(path)) continue;
      await send(`MKD ${path}`);            // 550 = exists, which is the goal
      made.add(path);
    }
  }

  async function upload(remote, body) {
    await ensureDir(posix.dirname(remote));
    const tmp = `${remote}.tmp`;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

    const data = await openData();
    try {
      // Both halves of "finished", registered before STOR so neither can be
      // missed: the 226 and the data channel's close race each other.
      const flushed = new Promise((res, rej) => {
        data.once('close', res);
        data.once('error', rej);
      });
      // The control channel says nothing at all while the bytes move, so its
      // idle timer has to stand down or it will kill a healthy transfer.
      control.setTimeout(0);
      ok(await send(`STOR ${tmp}`), 150, 125);
      data.end(buf);
      await flushed;
      ok(await reply(), 226, 250);
    } finally {
      data.destroy();
      control.setTimeout(timeout);
    }

    // Rename into place. Servers differ on whether RNTO may overwrite; the ones
    // that allow it give the reader no window at all, so it is tried first and
    // the delete is the fallback rather than the routine.
    const first = await send(`RNFR ${tmp}`);
    if (first.code === 350) {
      const done = await send(`RNTO ${remote}`);
      if (done.code === 250) return;
    }
    await send(`DELE ${remote}`);
    ok(await send(`RNFR ${tmp}`), 350);
    ok(await send(`RNTO ${remote}`), 250);
  }

  async function close() {
    if (!control) return;
    // A failed QUIT is not worth reporting: the files are already there, and the
    // most common cause is a server that hangs up the moment it reads the word.
    try { await send('QUIT'); } catch { /* already gone */ }
    control.destroy();
    control = null;
  }

  /**
   * What this connection turned out to be, for the job log.
   *
   * Worth writing down because the two things most likely to go wrong on an
   * unfamiliar host are invisible otherwise: whether TLS is actually in use,
   * and whether there is a session for the data channel to resume. A `425` with
   * `sessionReady: false` beside it in the log is a solved problem; the same
   * `425` on its own is an afternoon.
   */
  const status = () => ({
    secure,
    protocol: secure ? (control?.getProtocol?.() ?? null) : null,
    sessionReady: secure ? session !== null && session !== undefined : null,
    passive: usePasv ? 'PASV' : 'EPSV',
  });

  return {
    connect, ensureDir, upload, close, status,
    get remoteDir() { return opts.dir ?? '.'; },
  };
}
