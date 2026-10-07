import { readFileSync } from 'node:fs';
import { IMAGE_TEXT_PROMPT, IMAGE_TEXT_SCHEMA } from '../../src/ai/plan-texts';
async function main() {
  const t = Date.now();
  const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: 'qwen3-vl:4b', stream: false, think: false, format: IMAGE_TEXT_SCHEMA, options: { temperature: 0 }, messages: [{ role: 'user', content: IMAGE_TEXT_PROMPT, images: [readFileSync(process.argv[2]).toString('base64')] }] }) });
  const j = await res.json();
  console.log(((Date.now() - t) / 1000).toFixed(1), 's');
  console.log(j.message?.content?.slice(0, 3000) ?? JSON.stringify(j).slice(0, 500));
}
main();
