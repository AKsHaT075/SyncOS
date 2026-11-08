const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectUpload, sanitizeFileName, withExtension } = require('../../src/utils/fileValidation');
const LocalStorageProvider = require('../../src/storage/local.provider');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncos-fv-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function tmp(name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml'), Buffer.alloc(64)]);

describe('sanitizeFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\cmd.exe', 'cmd.exe'],
    ['report<>:"|?*.pdf', 'report_______.pdf'],
    ['.hidden.pdf', 'hidden.pdf'],
    ['   ', 'untitled'],
    ['con.txt', '_con.txt'],
    ['trailing dots...', 'trailing dots'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('bounds the length but keeps the extension', () => {
    const result = sanitizeFileName(`${'a'.repeat(500)}.pdf`);
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('withExtension re-appends the real extension', () => {
    expect(withExtension('Quarterly', 'pdf')).toBe('Quarterly.pdf');
    expect(withExtension('Quarterly.pdf', 'pdf')).toBe('Quarterly.pdf');
  });
});

describe('inspectUpload', () => {
  it('accepts a real PDF and derives server-side metadata', async () => {
    const meta = await inspectUpload({ filePath: tmp('a.pdf', PDF), originalName: 'a.pdf', clientMime: 'application/pdf' });
    expect(meta).toMatchObject({ extension: 'pdf', mimeType: 'application/pdf', category: 'pdf', inline: true });
    expect(meta.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects disallowed extensions', async () => {
    await expect(
      inspectUpload({ filePath: tmp('x.exe', Buffer.from('MZ')), originalName: 'x.exe', clientMime: 'application/x-msdownload' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('rejects a mismatching client MIME type', async () => {
    await expect(
      inspectUpload({ filePath: tmp('b.pdf', PDF), originalName: 'b.pdf', clientMime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'MIME_TYPE_MISMATCH' });
  });

  it('does not trust the extension: a script renamed .pdf fails the content check', async () => {
    await expect(
      inspectUpload({ filePath: tmp('evil.pdf', '<script>alert(1)</script>'), originalName: 'evil.pdf', clientMime: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
  });

  it('rejects an HTML payload dressed up as a PNG', async () => {
    await expect(
      inspectUpload({ filePath: tmp('p.png', '<html></html>'), originalName: 'p.png', clientMime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
  });

  it('accepts png and tolerates a generic octet-stream claim', async () => {
    const meta = await inspectUpload({ filePath: tmp('p2.png', PNG), originalName: 'p2.png', clientMime: 'application/octet-stream' });
    expect(meta.mimeType).toBe('image/png');
  });

  it('distinguishes a real docx from a plain zip renamed to .docx', async () => {
    await expect(
      inspectUpload({ filePath: tmp('real.docx', DOCX), originalName: 'real.docx', clientMime: '' }),
    ).resolves.toMatchObject({ category: 'word' });
    await expect(
      inspectUpload({ filePath: tmp('fake.docx', ZIP), originalName: 'fake.docx', clientMime: '' }),
    ).rejects.toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
  });

  it('rejects binary content posing as text/csv', async () => {
    await expect(
      inspectUpload({ filePath: tmp('b.csv', Buffer.from([0, 1, 2, 3, 0, 0])), originalName: 'b.csv', clientMime: 'text/csv' }),
    ).rejects.toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
    await expect(
      inspectUpload({ filePath: tmp('ok.csv', 'a,b\n1,2\n'), originalName: 'ok.csv', clientMime: 'application/vnd.ms-excel' }),
    ).resolves.toMatchObject({ mimeType: 'text/csv' });
  });

  it('rejects empty files and files over the configured limit', async () => {
    await expect(
      inspectUpload({ filePath: tmp('empty.txt', ''), originalName: 'empty.txt', clientMime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    // jest sets DOCUMENT_MAX_FILE_SIZE_MB=1
    await expect(
      inspectUpload({ filePath: tmp('big.txt', Buffer.alloc(1024 * 1024 + 1, 97)), originalName: 'big.txt', clientMime: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});

describe('LocalStorageProvider', () => {
  const root = path.join(dir, 'store');
  const storage = new LocalStorageProvider({ root });

  it.each(['../escape', '/abs/path', 'a/../../b', 'a//b', '.hidden', 'a/.b', ''])('refuses key %p', (key) => {
    expect(() => storage.resolve(key)).toThrow();
  });

  it('round-trips put / stat / copy / remove', async () => {
    await storage.put('org1/file1', tmp('src.bin', 'hello'));
    expect(await storage.stat('org1/file1')).toEqual({ size: 5 });
    await storage.copy('org1/file1', 'org1/file2');
    expect(await storage.stat('org1/file2')).toEqual({ size: 5 });
    await storage.remove('org1/file1');
    expect(await storage.stat('org1/file1')).toBeNull();
    await expect(storage.remove('org1/file1')).resolves.toBeUndefined();
  });
});
