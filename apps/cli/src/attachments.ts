import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { extractPdfAttachmentText } from "@xyst/runtime";

const MAX_ATTACHMENTS = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export type AgentUserMessage = { role: "user"; content: string | Array<Record<string, unknown>> };

function imageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export async function createAgentUserMessage(objective: string, paths: string[], ocrLanguages: string[] = ["eng"]): Promise<AgentUserMessage> {
  if (paths.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} files can be attached to one task`);
  if (!paths.length) return { role: "user", content: objective };
  const content: Array<Record<string, unknown>> = [{ type: "text", text: objective }];
  let totalBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const inputPath of paths) {
    const path = resolve(inputPath);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${path}`);
    const extension = extname(path).toLowerCase();
    const imageCandidate = [".png", ".jpg", ".jpeg", ".webp"].includes(extension);
    const pdfCandidate = extension === ".pdf";
    const maxBytes = imageCandidate ? MAX_IMAGE_BYTES : pdfCandidate ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
    if (info.size > maxBytes) throw new Error(`Attachment ${basename(path)} exceeds the ${imageCandidate ? "8 MiB image" : pdfCandidate ? "20 MiB PDF" : "1 MiB text"} limit`);
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Combined attachments exceed the 20 MiB limit");
    const bytes = await readFile(path);
    const detectedType = imageType(bytes);
    if (pdfCandidate) {
      if (bytes.toString("ascii", 0, 5) !== "%PDF-") throw new Error(`Attachment ${basename(path)} does not have a PDF signature`);
      const extracted = await extractPdfAttachmentText(bytes, 30_000, ocrLanguages);
      if (!extracted.text.trim()) throw new Error(`PDF attachment ${basename(path)} has no extractable text, including offline OCR`);
      const extraction = extracted.ocrPages ? `; offline OCR on ${extracted.ocrPages} pages` : "";
      content.push({ type: "text", text: `[Attached PDF: ${basename(path)}; ${extracted.pageCount} pages${extraction}${extracted.truncated ? "; text truncated" : ""}]\n${extracted.text}\n[End attached PDF]` });
      continue;
    }
    if (imageCandidate) {
      if (!detectedType) throw new Error(`Attachment ${basename(path)} does not have a supported PNG, JPEG, or WebP signature`);
      content.push({ type: "text", text: `[Attached image: ${basename(path)}]` });
      content.push({ type: "image_url", image_url: { url: `data:${detectedType};base64,${bytes.toString("base64")}` } });
      continue;
    }
    if (detectedType || bytes.includes(0)) throw new Error(`Attachment ${basename(path)} is binary; only text files and PNG, JPEG, or WebP images are supported`);
    let text: string;
    try { text = decoder.decode(bytes); }
    catch { throw new Error(`Attachment ${basename(path)} is not valid UTF-8 text`); }
    content.push({ type: "text", text: `[Attached text file: ${basename(path)}]\n${text}\n[End attached file]` });
  }
  return { role: "user", content };
}
