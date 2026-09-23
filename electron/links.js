'use strict';

const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

function resolveLink(href, documentPath) {
  if (typeof href !== 'string' || !href.trim()) throw new Error('The link has no destination');
  href = href.trim();
  if (href.startsWith('#')) return { kind: 'anchor', hash: href };
  if (href.startsWith('//')) href = 'https:' + href;
  const base = typeof documentPath === 'string' && path.isAbsolute(documentPath)
    ? pathToFileURL(documentPath) : undefined;
  let url;
  try { url = new URL(href, base); }
  catch (_) { throw new Error('Cannot resolve this link without the Markdown file path'); }
  if (['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol)) {
    return { kind: 'external', url: url.href };
  }
  if (url.protocol !== 'file:') throw new Error('Unsupported link protocol: ' + url.protocol);
  const filePath = fileURLToPath(url);
  return {
    kind: /\.(md|markdown|txt)$/i.test(filePath) ? 'markdown' : 'file',
    path: filePath,
    hash: url.hash,
  };
}

module.exports = { resolveLink };
