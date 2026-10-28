import { cleanName, MAX_PROOF_BYTES, proofFiles } from './proof-files';

const pdf = Buffer.from('%PDF-1.7\n...');
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);

describe('proofFiles', () => {
  it('should take images and PDFs by what they contain, whatever they are called', () => {
    const out = proofFiles([
      { originalname: 'plan.txt', buffer: pdf },
      { originalname: 'photo.pdf', buffer: png },
    ]);
    expect(out.problems).toEqual([]);
    expect(out.files.map((f) => f.mimeType)).toEqual(['application/pdf', 'image/png']);
  });

  it('should refuse other files, empty ones, big ones and too many', () => {
    const out = proofFiles([
      { originalname: 'a.exe', buffer: Buffer.from('MZ....') },
      { originalname: 'b.pdf', buffer: Buffer.alloc(0) },
      { originalname: 'c.pdf', buffer: Buffer.concat([pdf, Buffer.alloc(MAX_PROOF_BYTES)]) },
      ...Array.from({ length: 4 }, (_, i) => ({ originalname: `d${i}.pdf`, buffer: pdf })),
    ]);
    expect(out.problems).toEqual([
      'Attach at most 5 files.',
      'a.exe is not an image (JPG, PNG, WebP) or a PDF.',
      'b.pdf is empty.',
      'c.pdf is over 5 MB.',
    ]);
    expect(out.files).toHaveLength(2);
  });

  it('should keep no path or control characters in a name', () => {
    expect(cleanName('..\\evil/dir/proof"1".pdf')).toBe('proof_1_.pdf');
    expect(cleanName(undefined)).toBe('file');
  });
});
