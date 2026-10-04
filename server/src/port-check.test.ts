import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortInfo } from './port-check.js';

const PORT = 61822;

test('win32: a LISTENING socket on the port is in use, with its pid', () => {
  const stdout = [
    '  TCP    0.0.0.0:61822          0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:53764        127.0.0.1:61822        ESTABLISHED     9001',
  ].join('\n');

  assert.deepEqual(parsePortInfo(stdout, 'win32', PORT), { inUse: true, pid: '4242' });
});

test('win32: leftover TIME_WAIT sockets do not count as in use', () => {
  // These are client sockets whose *remote* end was the server. They linger
  // after it exits; matching them made the server refuse to start on a free
  // port and print "in use by undefined" with PID 0.
  const stdout = [
    '  TCP    127.0.0.1:53753        127.0.0.1:61822        TIME_WAIT       0',
    '  TCP    127.0.0.1:53764        127.0.0.1:61822        TIME_WAIT       0',
  ].join('\n');

  assert.deepEqual(parsePortInfo(stdout, 'win32', PORT), { inUse: false });
});

test('win32: a listener on a different port that merely contains the digits is ignored', () => {
  const stdout = '  TCP    0.0.0.0:618220         0.0.0.0:0              LISTENING       7777';

  assert.deepEqual(parsePortInfo(stdout, 'win32', PORT), { inUse: false });
});

test('win32: a listener reported with pid 0 is in use but has no killable pid', () => {
  const stdout = '  TCP    0.0.0.0:61822          0.0.0.0:0              LISTENING       0';

  assert.deepEqual(parsePortInfo(stdout, 'win32', PORT), { inUse: true, pid: undefined });
});

test('win32: empty output means the port is free', () => {
  assert.deepEqual(parsePortInfo('', 'win32', PORT), { inUse: false });
  assert.deepEqual(parsePortInfo('\n  \n', 'win32', PORT), { inUse: false });
});

test('posix: lsof output carries the command and pid', () => {
  // The caller already filtered to LISTEN lines with grep
  const stdout = 'node    8123 me   21u  IPv4 0x1  0t0  TCP 127.0.0.1:61822 (LISTEN)';

  assert.deepEqual(parsePortInfo(stdout, 'linux', PORT), {
    inUse: true,
    pid: '8123',
    command: 'node',
  });
});

test('posix: empty lsof output means the port is free', () => {
  assert.deepEqual(parsePortInfo('', 'darwin', PORT), { inUse: false });
});
