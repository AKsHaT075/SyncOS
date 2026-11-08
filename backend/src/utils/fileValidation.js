const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const AppError = require('./app-error');
const {
  ALLOWED_FILE_TYPES,
  DOCUMENT_MAX_FILE_SIZE_BYTES,
  GENERIC_CLIENT_MIMES,
  MAX_FILE_NAME_LENGTH,
} = require('../constants/document.constants');

const HEAD_BYTES = 8 * 1024;
const OOXML_HEAD_SCAN = 512 * 1024;
const OOXML_TAIL_SCAN = 128 * 1024;

// Windows-reserved characters, path separators, and control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * multer/busboy may hand UTF-8 names over as latin1-decoded strings. If the
 * bytes round-trip cleanly as UTF-8, prefer that reading.
 */
function decodeOriginalName(name) {
  if (typeof name !== 'string') return '';
  if (/[^\u0000-ÿ]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

/**
 * Produces a display/download name that is safe on every OS and can never
 * address a path: no separators, no control chars, no leading dots, bounded
 * length, extension preserved. Never used to build a storage path.
 */
function sanitizeFileName(raw, fallback = 'untitled') {
  let name = String(raw ?? '')
    .normalize('NFC')
    .split(/[\\/]/)
    .pop()
    .replace(UNSAFE_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');

  if (!name) {
    name = fallback;
  }
  if (WINDOWS_RESERVED.test(name)) {
    name = `_${name}`;
  }

  if (name.length > MAX_FILE_NAME_LENGTH) {
    const ext = path.extname(name);
    const keep = MAX_FILE_NAME_LENGTH - ext.length;
    name = `${name.slice(0, Math.max(1, keep))}${ext.length < MAX_FILE_NAME_LENGTH ? ext : ''}`;
  }
  return name;
}

function getExtension(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

/** Ensures a display name ends with the document's real extension. */
function withExtension(name, extension) {
  const clean = sanitizeFileName(name);
  if (getExtension(clean) === extension) {
    return clean;
  }
  const base = clean.length + extension.length + 1 > MAX_FILE_NAME_LENGTH
    ? clean.slice(0, MAX_FILE_NAME_LENGTH - extension.length - 1)
    : clean;
  return `${base}.${extension}`;
}

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function looksLikeText(buffer) {
  if (buffer.length === 0) return true;
  let control = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / buffer.length < 0.02;
}

async function readRange(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function matchesSignature(handle, size, entry) {
  const head = await readRange(handle, 0, Math.min(size, HEAD_BYTES));

  switch (entry.signature) {
    case 'pdf':
      return head.subarray(0, 1024).includes('%PDF-');
    case 'png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'ole':
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'text':
      return looksLikeText(head);
    case 'zip':
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]);
    case 'ooxml': {
      if (!startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return false;
      // An OOXML file is a zip whose entry names include the format folder
      // (word/, xl/, ppt/). Local headers sit near the start, the central
      // directory at the end — check both so a plain zip renamed to .docx fails.
      const headScan = await readRange(handle, 0, Math.min(size, OOXML_HEAD_SCAN));
      if (headScan.includes(entry.ooxmlDir)) return true;
      const tailStart = Math.max(0, size - OOXML_TAIL_SCAN);
      const tailScan = await readRange(handle, tailStart, size - tailStart);
      return tailScan.includes(entry.ooxmlDir);
    }
    default:
      return false;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Validates an uploaded temp file and returns trusted metadata derived by the
 * server. Order of trust: extension allow-list → size → client MIME is
 * consistent (never sufficient) → the bytes actually match the format.
 */
async function inspectUpload({ filePath, originalName, clientMime }) {
  const extension = getExtension(originalName);
  const entry = ALLOWED_FILE_TYPES[extension];
  if (!entry) {
    throw new AppError('This file type is not allowed', 400, 'UNSUPPORTED_FILE_TYPE');
  }

  const { size } = await fsp.stat(filePath);
  if (size === 0) {
    throw new AppError('The uploaded file is empty', 400, 'EMPTY_FILE');
  }
  if (size > DOCUMENT_MAX_FILE_SIZE_BYTES) {
    throw new AppError(
      `File is too large (max ${Math.round(DOCUMENT_MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB)`,
      413,
      'FILE_TOO_LARGE',
    );
  }

  const claimed = String(clientMime || '').toLowerCase().split(';')[0].trim();
  if (!GENERIC_CLIENT_MIMES.includes(claimed) && !entry.clientMimes.includes(claimed)) {
    throw new AppError('The file type does not match its extension', 400, 'MIME_TYPE_MISMATCH');
  }

  const handle = await fsp.open(filePath, 'r');
  let signatureOk;
  try {
    signatureOk = await matchesSignature(handle, size, entry);
  } finally {
    await handle.close();
  }
  if (!signatureOk) {
    throw new AppError('The file content does not match its type', 400, 'FILE_CONTENT_MISMATCH');
  }

  return {
    extension,
    category: entry.category,
    mimeType: entry.mime,
    inline: Boolean(entry.inline),
    size,
    checksum: await sha256File(filePath),
  };
}

module.exports = {
  decodeOriginalName,
  getExtension,
  inspectUpload,
  sanitizeFileName,
  withExtension,
};
