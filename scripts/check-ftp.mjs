/**
 * Round-trip src/ftp.js against an FTP server built for the purpose.
 *
 * Protocol code cannot be checked by reading it, and it cannot be checked
 * against the real web host either — that would mean testing on a live site to
 * find out whether the client works. So this stands a server up on loopback,
 * uploads a sample of the published tree through the real client, and compares
 * what arrived with what was sent.
 *
 * The server is deliberately awkward in the ways real ones are, one scenario at
 * a time: a multiline greeting and multiline login banner, a server too old for
 * EPSV, one that refuses to let RNTO overwrite, and explicit FTPS.
 *
 * The last check is the important one and it is done on the wire rather than
 * through Node's API. vsftpd ships `require_ssl_reuse=YES`, which refuses any
 * data connection whose TLS handshake did not resume the control connection's
 * session, and reports it as a bare `425` that names nothing. Node's own
 * `isSessionReused()` proved useless as a test signal — two in-process Node TLS
 * servers sharing ticket keys would not report a resumption even to themselves,
 * so a test built on it would have passed or failed for reasons unrelated to
 * this client. What the client is actually responsible for is *offering* the
 * session, and that is visible in the bytes it sends: a resuming ClientHello
 * carries a `pre_shared_key` extension under TLS 1.3, or a non-empty session id
 * under TLS 1.2. So the data channel for that check is a plain socket that
 * reads the ClientHello and looks.
 *
 * The FTPS scenarios need a certificate, which Node cannot mint on its own, so
 * one is generated with openssl at run time and thrown away. No key is kept in
 * this repository. Where openssl is missing the plain-FTP scenarios still run
 * and the rest are skipped out loud.
 *
 * Run it after touching src/ftp.js. It needs no network and no credentials.
 */
import { createServer as createTcp } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createFtp } from '../src/ftp.js';

/* ---------- a throwaway certificate for 127.0.0.1 ---------- */
function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-ftp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
      '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const PAIR = makeCert();
// Both the control server and every one-shot data server must share these, or
// no session can ever resume across them and the reuse scenario would fail for
// a reason that has nothing to do with the client.
const TICKETS = randomBytes(48);

/* ---------- the awkward server ---------- */

/**
 * Does this ClientHello say "I have been here before"?
 *
 * Under TLS 1.3 the answer is a `pre_shared_key` extension (41) and nothing
 * else. The legacy session id is *not* a signal there: a 1.3 client fills it
 * with 32 random bytes on every handshake, resumption or not, so that middle
 * boxes still see something that looks like TLS 1.2. Reading it as one made
 * this check pass against a client that had been deliberately broken, which is
 * how the mistake was found. The session id is only meaningful when the client
 * did not offer 1.3 at all — no `supported_versions` extension (43).
 */
function offersResumption(hello) {
  try {
    if (hello[0] !== 0x16 || hello[5] !== 0x01) return false;   // handshake, ClientHello
    let i = 9 + 2 + 32;                                          // client_version + random
    const sidLen = hello[i];
    i += 1 + sidLen;
    i += 2 + hello.readUInt16BE(i);                              // cipher suites
    i += 1 + hello[i];                                           // compression methods
    const end = Math.min(i + 2 + hello.readUInt16BE(i), hello.length);
    i += 2;
    let psk = false, thirteen = false;
    while (i + 4 <= end) {
      const type = hello.readUInt16BE(i);
      if (type === 41) psk = true;                               // pre_shared_key
      if (type === 43) thirteen = true;                          // supported_versions
      i += 4 + hello.readUInt16BE(i + 2);
    }
    return thirteen ? psk : sidLen > 0;
  } catch {
    return false;                                                // truncated: no claim either way
  }
}

function ftpServer({ tls = false, noEpsv = false, noOverwrite = false, multiline = false,
                     peekHello = null, password = 'secret' } = {}) {
  const got = new Map();                    // path -> Buffer, what actually arrived
  const dirs = new Set();
  let renameFrom = null, prot = false, dataWaiter = null;

  function talk(sock, greet) {
    let buf = '';
    const say = (code, text, more = null) =>
      sock.write(more ? `${code}-${more}\r\n${code} ${text}\r\n` : `${code} ${text}\r\n`);
    if (greet) say(220, 'ready', multiline ? 'Welcome to the test server\r\n220-Behave yourself' : null);

    sock.on('error', () => {});
    sock.on('data', d => {
      buf += d.toString('latin1');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        void run(line, say, sock);
      }
    });
  }

  async function run(line, say, sock) {
    const [verb, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    switch (verb.toUpperCase()) {
      case 'AUTH': {
        if (!tls) return say(500, 'not understood');
        say(234, 'go ahead');
        sock.removeAllListeners('data');
        const up = new TLSSocket(sock, { isServer: true, key: PAIR.key, cert: PAIR.cert, ticketKeys: TICKETS });
        return up.on('secure', () => talk(up, false));
      }
      case 'PBSZ': return say(200, 'ok');
      case 'PROT': prot = arg === 'P'; return say(200, 'ok');
      case 'USER': return say(331, 'password required');
      case 'PASS': return arg === password
        ? say(230, 'logged in', multiline ? 'Disk quota: plenty\r\n230-Last login: never' : null)
        : say(530, 'not logged in');
      case 'TYPE': return say(200, 'binary');
      case 'CWD': return arg === '/site' || dirs.has(arg) ? say(250, 'here') : say(550, 'no such directory');
      case 'MKD':
        if (dirs.has(arg)) return say(550, 'already exists');
        dirs.add(arg);
        return say(257, `"${arg}" created`);
      case 'EPSV':
        return noEpsv ? say(500, 'not understood')
          : say(229, `Entering Extended Passive Mode (|||${await passive()}|)`);
      case 'PASV': {
        const p = await passive();
        // The address here is deliberately a lie the client must ignore, the
        // way a NATted server's is.
        return say(227, `Entering Passive Mode (10,9,8,7,${p >> 8},${p & 255})`);
      }
      case 'STOR':
        say(150, 'opening data connection');
        try {
          got.set(arg, await dataWaiter);
          return say(226, 'transfer complete');
        } catch (e) {
          return say(425, e.message);
        }
      case 'RNFR':
        if (!got.has(arg)) return say(550, 'no such file');
        renameFrom = arg;
        return say(350, 'ready for destination');
      case 'RNTO':
        if (noOverwrite && got.has(arg)) return say(553, 'file exists');
        got.set(arg, got.get(renameFrom));
        got.delete(renameFrom);
        return say(250, 'renamed');
      case 'DELE':
        if (!got.has(arg)) return say(550, 'no such file');
        got.delete(arg);
        return say(250, 'deleted');
      case 'QUIT':
        say(221, 'bye');
        return sock.end();
      default: return say(502, `${verb} not implemented`);
    }
  }

  /** One listener per transfer, which is what a passive port is. */
  const passive = () => new Promise(resolve => {
    let settle;
    dataWaiter = new Promise((res, rej) => { settle = (e, v) => (e ? rej(e) : res(v)); });
    // The STOR handler is what awaits this, and a data connection can fail
    // before STOR is even sent. Mark it handled so an early rejection is an
    // answer rather than an unhandled-rejection crash.
    dataWaiter.catch(() => {});

    const accept = s => {
      const chunks = [];
      s.on('error', e => { settle(e); srv.close(); });
      s.on('data', c => chunks.push(c));
      s.on('close', () => { settle(null, Buffer.concat(chunks)); srv.close(); });
    };
    // For the resumption check the data channel stays plain TCP: we want the
    // client's ClientHello as bytes, not as a finished TLS session.
    const srv = peekHello
      ? createTcp(s => s.once('data', hello => { peekHello(hello); s.destroy(); settle(new Error('inspected')); srv.close(); }))
      : tls && prot
        ? createTlsServer({ key: PAIR.key, cert: PAIR.cert, ticketKeys: TICKETS }, accept)
        : createTcp(accept);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });

  const server = createTcp(s => talk(s, true));
  return {
    got,
    close: () => server.close(),
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
  };
}

/* ---------- the checks ---------- */

const SAMPLE = new Map([
  ['index.html', '<!doctype html><title>rain</title>'],
  ['style.css', 'body{color:#111}'],
  ['data/meta.json', JSON.stringify({ fields: [{ id: 'home7', name: 'Home 7' }] })],
  ['data/series/home7/current.json', JSON.stringify({ days: [0, 1, 2], cols: { mrms: [0.185, null, 0] } })],
  // Comfortably past one socket write, which is where a client that treats the
  // 226 and the data channel's close as the same event truncates the file.
  ['data/series/home7/history.json', JSON.stringify({ days: Array.from({ length: 60000 }, (_, i) => i) })],
]);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};

async function scenario(name, opts = {}) {
  console.log(`\n${name}`);
  const srv = ftpServer(opts);
  const port = await srv.listen();
  const client = createFtp({
    host: '127.0.0.1', port, user: 'farm', password: 'secret',
    secure: !!opts.tls, allowSelfSigned: true, dir: '/site', timeoutSeconds: 20,
  });
  try {
    await client.connect();
    for (const [rel, body] of SAMPLE) await client.upload(rel, body);
    await client.close();

    check('every file arrived', srv.got.size === SAMPLE.size, `${srv.got.size} of ${SAMPLE.size}`);
    for (const [rel, body] of SAMPLE) {
      const arrived = srv.got.get(rel);
      check(`${rel} byte for byte`, !!arrived && arrived.equals(Buffer.from(body, 'utf8')),
        arrived ? `${arrived.length} bytes, expected ${Buffer.byteLength(body)}` : 'never arrived');
    }
    const tmps = [...srv.got.keys()].filter(k => k.endsWith('.tmp'));
    check('nothing left named .tmp', tmps.length === 0, tmps.join(', '));
  } catch (e) {
    check('the run completed', false, e.message);
    try { await client.close(); } catch { /* already gone */ }
  } finally {
    srv.close();
  }
}

async function expectFailure(name, opts, wanted) {
  console.log(`\n${name}`);
  const srv = ftpServer(opts);
  const port = await srv.listen();
  const client = createFtp({
    host: '127.0.0.1', port, user: 'farm', password: 'wrong',
    secure: !!opts.tls, allowSelfSigned: true, dir: '/site', timeoutSeconds: 10,
  });
  let message = null;
  try {
    await client.connect();
    await client.upload('index.html', 'x');
  } catch (e) {
    message = e.message;
  } finally {
    try { await client.close(); } catch { /* fine */ }
    srv.close();
  }
  check(`refused, and says so: ${wanted}`, !!message && message.includes(wanted),
    message ?? 'it succeeded, which it should not have');
}

/** The vsftpd `require_ssl_reuse` check: does the data channel's ClientHello
 *  offer the control connection's session? */
async function reuseCheck() {
  console.log('\nExplicit FTPS offers the control session on the data channel');
  let hello = null;
  const srv = ftpServer({ tls: true, peekHello: b => { hello = b; } });
  const port = await srv.listen();
  const client = createFtp({
    host: '127.0.0.1', port, user: 'farm', password: 'secret',
    secure: true, allowSelfSigned: true, dir: '/site', timeoutSeconds: 15,
  });
  try {
    await client.connect();
    check('the control session was captured', client.status().sessionReady === true,
      `status ${JSON.stringify(client.status())}`);
    await client.upload('index.html', 'x').catch(() => {});   // the peek server hangs up on purpose
    check('a ClientHello reached the data channel', hello !== null);
    check('it offers the session, so require_ssl_reuse would accept it',
      hello !== null && offersResumption(hello),
      hello ? `${hello.length} bytes, no pre_shared_key and no session id` : 'nothing arrived');
  } catch (e) {
    check('the reuse check ran', false, e.message);
  } finally {
    try { await client.close(); } catch { /* fine */ }
    srv.close();
  }
}

await scenario('Plain FTP, EPSV, multiline replies', { multiline: true });
await scenario('Plain FTP, server too old for EPSV', { noEpsv: true });
await scenario('Plain FTP, server refuses to overwrite on rename', { noOverwrite: true });
await expectFailure('Wrong password', {}, '530');

if (PAIR) {
  await scenario('Explicit FTPS', { tls: true, multiline: true });
  await scenario('Explicit FTPS, no EPSV, no overwrite', { tls: true, noEpsv: true, noOverwrite: true });
  await reuseCheck();
} else {
  console.log('\nSkipped the FTPS scenarios: openssl is not on this machine, so there is no');
  console.log('certificate to stand a TLS server up with. The plain-FTP checks above still ran.');
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nThe FTP client held up against every server this could think of.');
process.exitCode = failed ? 1 : 0;
