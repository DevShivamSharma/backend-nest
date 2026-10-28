/** The proof attached when a plan is sent back: images and PDF, a few, each of a limited size. */
export const MAX_PROOF_FILES = 5;
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export interface ProofFile {
  name: string;
  mimeType: string;
  size: number;
  data: Buffer;
}

/** An uploaded file as the multipart reader hands it over. */
export interface UploadedProof {
  originalname?: string;
  buffer?: Buffer;
  size?: number;
}

const SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 1024).includes('%PDF-') },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * The files as proof, or what is wrong with them. The type comes from what the file contains, not
 * from its name or what the browser says it is.
 */
export function proofFiles(files: readonly UploadedProof[] | undefined): {
  files: ProofFile[];
  problems: string[];
} {
  const list = files ?? [];
  const problems: string[] = [];
  if (list.length > MAX_PROOF_FILES) {
    problems.push(`Attach at most ${MAX_PROOF_FILES} files.`);
  }
  const out: ProofFile[] = [];
  for (const f of list.slice(0, MAX_PROOF_FILES)) {
    const name = cleanName(f.originalname);
    const data = f.buffer;
    if (!data?.length) {
      problems.push(`${name} is empty.`);
    } else if (data.length > MAX_PROOF_BYTES) {
      problems.push(`${name} is over 5 MB.`);
    } else {
      const found = SIGNATURES.find((s) => s.test(data));
      if (!found) problems.push(`${name} is not an image (JPG, PNG, WebP) or a PDF.`);
      else out.push({ name, mimeType: found.mime, size: data.length, data });
    }
  }
  return { files: out, problems };
}

/** A file name safe to keep and to put in a header: no path, no control characters. */
export function cleanName(name: string | undefined): string {
  const base = (name ?? 'file').replace(/\\/g, '/').split('/').pop() ?? 'file';
  // The browser sends the name as latin-1 bytes of its UTF-8.
  const text = Buffer.from(base, 'latin1').toString('utf8');
  const clean = (text.includes('�') ? base : text).replace(/[\u0000-\u001f"<>|:*?]/g, '_').trim();
  return (clean || 'file').slice(0, 200);
}
