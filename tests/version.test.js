'use strict';
// The version string is derived from git: nearest v<major>.<minor>.<patch>
// tag, commits since it, short hash, and a -dirty marker.
const { test } = require('node:test');
const assert = require('node:assert');
const { describeVersion, parseDescribe } = require('../tools/version.js');

test('parseDescribe: tag patch plus commits since, hash as build', () => {
  assert.deepStrictEqual(parseDescribe('v1.0.0-9-g56a2db3\n'), {
    version: '1.0.9', build: '56a2db3', dirty: false, label: '1.0.9 (56a2db3)',
  });
  assert.deepStrictEqual(parseDescribe('v1.2.3-4-gabcdef0'), {
    version: '1.2.7', build: 'abcdef0', dirty: false, label: '1.2.7 (abcdef0)',
  });
});

test('parseDescribe: exactly at a tag is that tag', () => {
  assert.strictEqual(parseDescribe('v2.0.0-0-g0123abc').version, '2.0.0');
});

test('parseDescribe: -dirty is carried on the build, not the version', () => {
  const v = parseDescribe('v1.0.0-9-g56a2db3-dirty');
  assert.strictEqual(v.version, '1.0.9');
  assert.strictEqual(v.build, '56a2db3-dirty');
  assert.strictEqual(v.dirty, true);
});

test('parseDescribe: rejects anything else', () => {
  assert.throws(() => parseDescribe('1.0.0'));
  assert.throws(() => parseDescribe('v1.0.0'));
  assert.throws(() => parseDescribe(''));
});

test('describeVersion: this checkout yields a well-formed version and build', () => {
  const v = describeVersion();
  assert.match(v.version, /^\d+\.\d+\.\d+$/);
  assert.match(v.build, /^([0-9a-f]{7,}(-dirty)?|unknown)$/);
  assert.strictEqual(v.label, v.version + ' (' + v.build + ')');
});
