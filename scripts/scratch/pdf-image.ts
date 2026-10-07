import { readFileSync } from 'node:fs';
async function main() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(process.argv[2])), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === pdfjs.OPS.paintImageXObject) {
      const name = ops.argsArray[i][0];
      const img = await new Promise<any>((res) => page.objs.get(name, res));
      console.log(name, img?.width, img?.height, img?.kind, img?.data?.length, Object.keys(img ?? {}));
    }
  }
  console.log(page.getViewport({ scale: 1 }).transform);
}
main();
