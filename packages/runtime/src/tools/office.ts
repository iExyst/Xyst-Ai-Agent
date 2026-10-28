import { mkdir, mkdtemp, copyFile, link, unlink, rm, readFile, writeFile, rename } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AccessController } from "../access.js";
import { runProcess } from "../platform.js";

const PptxGenJS = createRequire(import.meta.url)("pptxgenjs") as new () => any;

type Tool = { definition: Record<string, unknown>; execute(args: unknown, signal?: AbortSignal): Promise<unknown> };
const contentLimit = 500_000;
const rowLimit = 1000;
const spreadsheetCellSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]);
type SpreadsheetCell = z.infer<typeof spreadsheetCellSchema>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const docxEditSchema = z.object({ format: z.literal("docx"), path: z.string().min(1), expected_sha256: hashSchema, find_text: z.string().min(1).max(20_000), replace_text: z.string().max(20_000) }).strict();
const xlsxEditSchema = z.object({ format: z.literal("xlsx"), path: z.string().min(1), expected_sha256: hashSchema, operation: z.enum(["set_cell", "set_formula", "append_rows"]), sheet: z.string().min(1).max(31).optional(), cell: z.string().optional(), value: z.string().max(20_000).optional(), formula: z.string().min(2).max(20_000).regex(/^=/).optional(), rows: z.array(z.array(spreadsheetCellSchema).min(1).max(100)).max(rowLimit).optional() }).strict().superRefine((args, context) => {
  if (args.operation === "set_cell" && (!args.cell || args.value === undefined || args.rows !== undefined)) context.addIssue({ code: "custom", message: "set_cell requires cell and value and does not accept rows" });
  if (args.operation === "set_formula" && (!args.cell || !args.formula || args.value !== undefined || args.rows !== undefined)) context.addIssue({ code: "custom", message: "set_formula requires cell and a formula beginning with = and does not accept value or rows" });
  if (args.operation === "append_rows" && (!args.rows?.length || args.cell !== undefined || args.value !== undefined || args.formula !== undefined)) context.addIssue({ code: "custom", message: "append_rows requires rows and does not accept cell, value, or formula" });
});
const pptxEditSchema = z.object({ format: z.literal("pptx"), path: z.string().min(1), expected_sha256: hashSchema, find_text: z.string().min(1).max(20_000), replace_text: z.string().max(20_000) }).strict();
const pdfEditSchema = z.object({ format: z.literal("pdf"), path: z.string().min(1), expected_sha256: hashSchema, operation: z.literal("append_text"), page: z.number().int().min(1).max(1000), text: z.string().min(1).max(2000), x: z.number().min(0).max(10000).optional(), y: z.number().min(0).max(10000).optional(), font_size: z.number().min(6).max(72).optional() }).strict();
const officeEditSchema = z.discriminatedUnion("format", [docxEditSchema, xlsxEditSchema, pptxEditSchema, pdfEditSchema]);
const docxReadSchema = z.object({ format: z.literal("docx"), path: z.string().min(1), max_chars: z.number().int().min(1000).max(30000).optional() }).strict();
const xlsxReadSchema = z.object({ format: z.literal("xlsx"), path: z.string().min(1), sheet: z.string().min(1).max(31).optional(), max_chars: z.number().int().min(1000).max(30000).optional() }).strict();
const csvReadSchema = z.object({ format: z.literal("csv"), path: z.string().min(1), max_chars: z.number().int().min(1000).max(30000).optional() }).strict();
const pptxReadSchema = z.object({ format: z.literal("pptx"), path: z.string().min(1), max_chars: z.number().int().min(1000).max(30000).optional() }).strict();
const pdfReadSchema = z.object({ format: z.literal("pdf"), path: z.string().min(1), max_chars: z.number().int().min(1000).max(30000).optional() }).strict();
const officeReadSchema = z.discriminatedUnion("format", [docxReadSchema, xlsxReadSchema, csvReadSchema, pptxReadSchema, pdfReadSchema]);
const schema = z.object({
  format: z.enum(["docx", "xlsx", "csv", "pdf", "pptx"]), path: z.string().min(1), title: z.string().min(1).max(200),
  content: z.string().max(contentLimit).optional(), repeat_title: z.boolean().optional(), rows: z.array(z.array(spreadsheetCellSchema).min(1).max(100)).max(rowLimit).optional(),
  slides: z.array(z.object({ title: z.string().min(1).max(200), body: z.string().max(20_000) }).strict()).max(60).optional()
}).strict();

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
function removeLeadingDuplicateTitle(title: string, content: string, repeatTitle = false): string {
  if (repeatTitle) return content;
  const lines = content.split(/\r?\n/);
  let firstContentLine = 0;
  while (firstContentLine < lines.length && !lines[firstContentLine]!.trim()) firstContentLine++;
  if (lines[firstContentLine]?.trim() !== title.trim()) return content;
  const body = lines.slice(firstContentLine + 1);
  while (body.length && !body[0]!.trim()) body.shift();
  return body.join("\n");
}
function columnName(value: number): string { let name = ""; for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; }
function spreadsheetCellXml(value: SpreadsheetCell, address: string, header: boolean): string {
  const style = header ? ' s="1"' : "";
  if (typeof value === "number") return `<c r="${address}"${style}><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${address}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value === null) return `<c r="${address}"${style}/>`;
  if (value.startsWith("=")) return `<c r="${address}"${style}><f>${xml(value.slice(1))}</f><v></v></c>`;
  return `<c r="${address}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function spreadsheetXml(rows: SpreadsheetCell[][], title: string): Promise<Uint8Array> {
  const zipImport = import("jszip");
  return zipImport.then(async ({ default: JSZip }) => {
    const zip = new JSZip(); const columns = Math.max(...rows.map((row) => row.length));
    const columnXml = Array.from({ length: columns }, (_, i) => {
      const width = Math.min(50, Math.max(10, ...rows.slice(0, 200).map((row) => String(row[i] ?? "").length + 2)));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    }).join("");
    const dataXml = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, colIndex) => spreadsheetCellXml(value, `${columnName(colIndex + 1)}${rowIndex + 1}`, rowIndex === 0)).join("")}</row>`).join("");
    const filter = rows.length > 1 ? `<autoFilter ref="A1:${columnName(columns)}${rows.length}"/>` : "";
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${xml(title.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/><family val="2"/></font><font><b/><color rgb="FF0A1012"/><sz val="11"/><name val="Aptos"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF9BF5C2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><cols>${columnXml}</cols><sheetData>${dataXml}</sheetData>${filter}</worksheet>`);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  });
}

function csvText(rows: SpreadsheetCell[][]): string {
  return rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const code = entity.slice(1, -1);
    if (code === "amp") return "&"; if (code === "lt") return "<"; if (code === "gt") return ">"; if (code === "quot") return '"'; if (code === "apos") return "'";
    const numeric = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}

function xmlAttributes(value: string): Record<string, string> {
  return Object.fromEntries([...value.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map((match) => [match[1]!, decodeXml(match[2]!)]));
}

async function xlsxWorksheet(zip: any, requestedName?: string): Promise<{ name: string; path: string; xml: string; sharedStrings: string[] }> {
  const expanded = Object.values(zip.files as Record<string, unknown>).reduce<number>((sum, file) => sum + ((file as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (expanded > 150 * 1024 * 1024) throw new Error("XLSX package expands beyond the 150 MiB safety limit");
  const workbookFile = zip.file("xl/workbook.xml"); const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relsFile) throw new Error("XLSX package is missing workbook metadata");
  const workbookXml = await workbookFile.async("string"); const relationshipsXml = await relsFile.async("string");
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) { const attrs = xmlAttributes(match[1]!); if (attrs.Id && attrs.Target) relationships.set(attrs.Id, attrs.Target); }
  const sheets = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map((match) => xmlAttributes(match[1]!));
  const selected = requestedName ? sheets.find((sheet) => sheet.name === requestedName) : sheets.find((sheet) => !["hidden", "veryHidden"].includes(sheet.state ?? ""));
  if (!selected) throw new Error(requestedName ? `Worksheet not found: ${requestedName}` : "Workbook has no visible worksheets");
  const relationshipId = selected["r:id"]; const target = relationshipId ? relationships.get(relationshipId) : undefined;
  if (!target) throw new Error(`Worksheet ${selected.name} has no valid workbook relationship`);
  const worksheetPath = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join("xl", target));
  if (!worksheetPath.startsWith("xl/worksheets/") || worksheetPath.includes("../")) throw new Error("XLSX worksheet relationship points outside the worksheet directory");
  const worksheetSize = (zip.files[worksheetPath] as { _data?: { uncompressedSize?: number } } | undefined)?._data?.uncompressedSize ?? 0;
  if (worksheetSize > 20 * 1024 * 1024) throw new Error("Worksheet XML exceeds the 20 MiB processing limit");
  const worksheetFile = zip.file(worksheetPath); if (!worksheetFile) throw new Error(`Worksheet XML is missing: ${worksheetPath}`);
  const worksheetXml = await worksheetFile.async("string"); if (worksheetXml.length > 20 * 1024 * 1024) throw new Error("Worksheet XML exceeds the 20 MiB processing limit");
  const sharedFile = zip.file("xl/sharedStrings.xml"); const sharedXml = sharedFile ? await sharedFile.async("string") : "";
  const sharedSize = (zip.files["xl/sharedStrings.xml"] as { _data?: { uncompressedSize?: number } } | undefined)?._data?.uncompressedSize ?? 0;
  if (sharedSize > 20 * 1024 * 1024) throw new Error("Shared strings XML exceeds the 20 MiB processing limit");
  if (sharedXml.length > 20 * 1024 * 1024) throw new Error("Shared strings XML exceeds the 20 MiB processing limit");
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si\s*>/g)].map(([item]) => [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t\s*>/g)].map((text) => decodeXml(text[1]!)).join(""));
  return { name: selected.name ?? "Sheet1", path: worksheetPath, xml: worksheetXml, sharedStrings };
}

function spreadsheetCellValue(type: string | undefined, inner: string, sharedStrings: string[]): { value: string; formula?: string; cached_value?: string } {
  const formula = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f\s*>|<f\b[^>]*\/>/);
  if (formula) {
    const expression = `=${decodeXml(formula[1] ?? "[shared formula]")}`;
    const cached = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v\s*>/);
    return { value: expression, formula: expression, ...(cached ? { cached_value: decodeXml(cached[1]!) } : {}) };
  }
  if (type === "inlineStr") return { value: [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t\s*>/g)].map((match) => decodeXml(match[1]!)).join("") };
  const value = decodeXml(inner.match(/<v\b[^>]*>([\s\S]*?)<\/v\s*>/)?.[1] ?? "");
  if (type === "s") return { value: sharedStrings[Number(value)] ?? "" };
  if (type === "b") return { value: value === "1" ? "TRUE" : value === "0" ? "FALSE" : value };
  return { value };
}

function spreadsheetRows(worksheetXml: string, sharedStrings: string[], maxChars: number): { rows: Array<{ row: number; cells: Array<{ cell: string; value: string; formula?: string; cached_value?: string }> }>; truncated: boolean } {
  const output: Array<{ row: number; cells: Array<{ cell: string; value: string; formula?: string; cached_value?: string }> }> = []; let chars = 0; let truncated = false;
  for (const rowMatch of worksheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row\s*>/g)) {
    const row = Number(xmlAttributes(rowMatch[1]!).r); if (!Number.isSafeInteger(row) || row < 1) continue;
    const cells: Array<{ cell: string; value: string; formula?: string; cached_value?: string }> = [];
    for (const cellMatch of rowMatch[2]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c\s*>/g)) {
      const attrs = xmlAttributes(cellMatch[1]!); const address = attrs.r; if (!address) continue;
      const parsed = spreadsheetCellValue(attrs.t, cellMatch[2]!, sharedStrings);
      if (cells.length >= 100 || chars + parsed.value.length > maxChars) { truncated = true; break; }
      cells.push({ cell: address, ...parsed }); chars += parsed.value.length;
    }
    if (cells.length) output.push({ row, cells });
    if (truncated || output.length >= 1000) { truncated = true; break; }
  }
  return { rows: output, truncated };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (!(row.length === 1 && row[0] === "" && i === text.length - 1)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length || row.length || !rows.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readCsv(access: AccessController, path: string, maxChars: number): Promise<{ path: string; sha256: string; rows: Array<{ row: number; cells: Array<{ cell: string; value: string }> }>; truncated: boolean; trust: "untrusted-file-content" }> {
  path = await access.assertPath(path, "read"); const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("CSV reading is limited to files under 50 MiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(original).replace(/^\uFEFF/, "");
  const parsed = parseCsv(text); const rows: Array<{ row: number; cells: Array<{ cell: string; value: string }> }> = []; let chars = 0; let truncated = false;
  for (const [rowIndex, fields] of parsed.entries()) {
    const cells: Array<{ cell: string; value: string }> = [];
    for (const [columnIndex, value] of fields.entries()) {
      if (columnIndex >= 100 || chars + value.length > maxChars) { truncated = true; break; }
      cells.push({ cell: `${columnName(columnIndex + 1)}${rowIndex + 1}`, value }); chars += value.length;
    }
    if (cells.length) rows.push({ row: rowIndex + 1, cells });
    if (truncated || rows.length >= 1000) { truncated = true; break; }
  }
  return { path, sha256: createHash("sha256").update(original).digest("hex"), rows, truncated, trust: "untrusted-file-content" };
}

function parseCellAddress(value: string): { column: number; row: number; address: string } {
  const match = value.toUpperCase().replace(/\$/g, "").match(/^([A-Z]{1,3})([1-9]\d{0,6})$/);
  if (!match) throw new Error("Cell must use an address such as A1 or AB12");
  let column = 0; for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]); if (column > 16384 || row > 1_048_576) throw new Error("Cell address exceeds the XLSX worksheet limits");
  return { column, row, address: `${columnName(column)}${row}` };
}

function assertCellOutsideMergedRange(worksheetXml: string, address: string): void {
  const target = parseCellAddress(address);
  for (const match of worksheetXml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)) {
    const [startRef, endValue] = match[1]!.split(":"); if (!startRef) continue; const endRef = endValue ?? startRef; const start = parseCellAddress(startRef); const end = parseCellAddress(endRef);
    const inside = target.column >= start.column && target.column <= end.column && target.row >= start.row && target.row <= end.row;
    if (inside && (target.column !== start.column || target.row !== start.row)) throw new Error(`Cell ${target.address} belongs to merged range ${match[1]}; only its top-left cell can be edited`);
  }
}

function worksheetBounds(worksheetXml: string): { minColumn: number; minRow: number; maxColumn: number; maxRow: number } {
  let minColumn = Number.MAX_SAFE_INTEGER; let minRow = Number.MAX_SAFE_INTEGER; let maxColumn = 1; let maxRow = 1;
  const refs = [...worksheetXml.matchAll(/\br="\$?([A-Z]{1,3})\$?([1-9]\d{0,6})"/g)];
  const range = worksheetXml.match(/<dimension\b[^>]*\bref="([^"]+)"/);
  const all = [...refs.map((ref) => ref[0].match(/\$?([A-Z]{1,3})\$?([1-9]\d{0,6})/)?.[0] ?? ""), ...(range ? range[1]!.split(":") : [])].filter(Boolean);
  for (const cell of all) {
    const { column, row } = parseCellAddress(cell.split(":").at(-1)!);
    const first = cell.split(":")[0]!; const start = parseCellAddress(first);
    minColumn = Math.min(minColumn, start.column); minRow = Math.min(minRow, start.row); maxColumn = Math.max(maxColumn, column); maxRow = Math.max(maxRow, row);
  }
  return { minColumn: minColumn === Number.MAX_SAFE_INTEGER ? 1 : minColumn, minRow: minRow === Number.MAX_SAFE_INTEGER ? 1 : minRow, maxColumn, maxRow };
}

function updateWorksheetDimension(worksheetXml: string, cell: string): string {
  const bounds = worksheetBounds(worksheetXml); const added = parseCellAddress(cell);
  const minColumn = Math.min(bounds.minColumn, added.column); const minRow = Math.min(bounds.minRow, added.row);
  const maxColumn = Math.max(bounds.maxColumn, added.column); const maxRow = Math.max(bounds.maxRow, added.row);
  const ref = `${columnName(minColumn)}${minRow}:${columnName(maxColumn)}${maxRow}`;
  if (/<dimension\b[^>]*\bref="[^"]+"/.test(worksheetXml)) return worksheetXml.replace(/(<dimension\b[^>]*\bref=")[^"]+("[^>]*\/?\s*>)/, `$1${ref}$2`);
  return worksheetXml.replace(/(<(?:sheetViews|sheetFormatPr|cols|sheetData)\b)/, `<dimension ref="${ref}"/>$1`);
}

function insertWorksheetCell(worksheetXml: string, parsed: { column: number; row: number; address: string }, newCell: string): string {
  let updated = worksheetXml;
  const rowPattern = new RegExp(`<row\\b([^>]*\\br="${parsed.row}"[^>]*)>([\\s\\S]*?)<\\/row\\s*>`);
  const rowMatch = updated.match(rowPattern);
  const emptyRowPattern = new RegExp(`<row\\b([^>]*\\br="${parsed.row}"[^>]*)\\s*\\/\\s*>`);
  const emptyRow = updated.match(emptyRowPattern);
  if (emptyRow) updated = updated.replace(emptyRow[0], `<row${emptyRow[1]}>${newCell}</row>`);
  else if (rowMatch) {
    const cellMatches = [...rowMatch[2]!.matchAll(/<c\b([^>]*)(?:\/\s*>|>[\s\S]*?<\/c\s*>)/g)];
    const laterCell = cellMatches.find((match) => {
      const cellAddress = xmlAttributes(match[1]!).r; if (!cellAddress) return false;
      try { return parseCellAddress(cellAddress).column > parsed.column; } catch { return false; }
    });
    const at = laterCell?.index ?? rowMatch[2]!.length;
    const body = rowMatch[2]!.slice(0, at) + newCell + rowMatch[2]!.slice(at);
    updated = updated.replace(rowMatch[0], `<row${rowMatch[1]}>${body}</row>`);
  } else {
    const row = `<row r="${parsed.row}">${newCell}</row>`;
    const data = updated.match(/<sheetData\b([^>]*)>([\s\S]*?)<\/sheetData\s*>/);
    if (data) {
      const laterRow = [...data[2]!.matchAll(/<row\b([^>]*)>[\s\S]*?<\/row\s*>/g)].find((match) => Number(xmlAttributes(match[1]!).r) > parsed.row);
      const at = laterRow?.index ?? data[2]!.length;
      const body = data[2]!.slice(0, at) + row + data[2]!.slice(at);
      updated = updated.replace(data[0], `<sheetData${data[1]}>${body}</sheetData>`);
    } else {
      const emptyData = updated.match(/<sheetData\b([^>]*)\s*\/\s*>/);
      if (!emptyData) throw new Error("Worksheet XML is missing sheetData");
      updated = updated.replace(emptyData[0], `<sheetData${emptyData[1]}>${row}</sheetData>`);
    }
  }
  return updated;
}

function setWorksheetCell(worksheetXml: string, address: string, value: string): { xml: string; replacedFormula: boolean } {
  const parsed = parseCellAddress(address); const escaped = parsed.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assertCellOutsideMergedRange(worksheetXml, parsed.address);
  const cellPattern = new RegExp(`<c\\b([^>]*\\br="${escaped}"[^>]*)(?:\\s*\\/\\s*>|>([\\s\\S]*?)<\\/c\\s*>)`);
  const existing = worksheetXml.match(cellPattern);
  const inlineCell = (attributes: string) => {
    const clean = attributes.replace(/\s+t="[^"]*"/, ""); const newAttributes = `${clean} t="inlineStr"`;
    return `<c${newAttributes}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  };
  let updated = worksheetXml;
  if (existing) {
    if (/<f\b/.test(existing[2] ?? "")) return { xml: worksheetXml, replacedFormula: true };
    updated = updated.replace(existing[0], inlineCell(existing[1]!));
  } else {
    const newCell = `<c r="${parsed.address}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    updated = insertWorksheetCell(updated, parsed, newCell);
  }
  return { xml: updateWorksheetDimension(updated, parsed.address), replacedFormula: false };
}

function setWorksheetFormula(worksheetXml: string, address: string, formula: string): string {
  const parsed = parseCellAddress(address); const escaped = parsed.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assertCellOutsideMergedRange(worksheetXml, parsed.address);
  const cellPattern = new RegExp(`<c\\b([^>]*\\br="${escaped}"[^>]*)(?:\\s*\\/\\s*>|>([\\s\\S]*?)<\\/c\\s*>)`);
  const existing = worksheetXml.match(cellPattern);
  const attributes = existing ? existing[1]!.replace(/\s+t="[^"]*"/, "") : ` r="${parsed.address}"`;
  const formulaCell = `<c${attributes}><f>${xml(formula.slice(1))}</f><v></v></c>`;
  const updated = existing ? worksheetXml.replace(existing[0], formulaCell) : insertWorksheetCell(worksheetXml, parsed, formulaCell);
  return updateWorksheetDimension(updated, parsed.address);
}

type FormulaRecalculation = {
  status: "success" | "errors_found";
  formulas: number;
  evaluated: number;
  errors: number;
  cachesChanged: number;
  unknownFunctions: Array<{ name: string; cells: number }>;
  errorSummary: Record<string, { count: number; locations: string[]; messages: Array<string | null> }>;
};

async function recalculateFormulaCaches(bytes: Uint8Array): Promise<{ bytes: Uint8Array; report: FormulaRecalculation }> {
  const { recalculateXlsxBytes } = await import("formualizer");
  const result = await recalculateXlsxBytes(bytes, 40, { externalLinks: "refuse" });
  return {
    bytes: result.bytes,
    report: {
      status: result.summary.status,
      formulas: result.formula_cells,
      evaluated: result.summary.evaluated,
      errors: result.summary.errors,
      cachesChanged: result.cache_cells_changed,
      unknownFunctions: result.summary.unknown_functions.slice(0, 30),
      errorSummary: result.summary.error_summary ?? {}
    }
  };
}

async function worksheetHasFormulas(zip: { files: Record<string, any>; file(path: string): any }): Promise<boolean> {
  const paths = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path) && !zip.files[path]?.dir);
  const parts = await Promise.all(paths.map((path) => zip.file(path)!.async("string") as Promise<string>));
  return parts.some((part) => /<f\b/.test(part));
}

async function readXlsx(access: AccessController, path: string, sheetName: string | undefined, maxChars: number): Promise<{ path: string; sha256: string; sheet: string; rows: Array<{ row: number; cells: Array<{ cell: string; value: string }> }>; truncated: boolean; trust: "untrusted-file-content" }> {
  path = await access.assertPath(path, "read"); const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("XLSX reading is limited to files under 50 MiB");
  const { default: JSZip } = await import("jszip"); const zip = await JSZip.loadAsync(original);
  const selected = await xlsxWorksheet(zip, sheetName); const parsed = spreadsheetRows(selected.xml, selected.sharedStrings, maxChars);
  return { path, sha256: createHash("sha256").update(original).digest("hex"), sheet: selected.name, ...parsed, trust: "untrusted-file-content" };
}

async function editXlsx(access: AccessController, args: z.infer<typeof xlsxEditSchema>, path: string): Promise<Record<string, unknown>> {
  path = await access.assertPath(path, "read"); path = await access.assertPath(path, "write"); const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("XLSX editing is limited to files under 50 MiB");
  const originalHash = createHash("sha256").update(original).digest("hex");
  if (originalHash.toLowerCase() !== args.expected_sha256.toLowerCase()) throw new Error("File changed since it was read; reload it before editing");
  if (args.rows && args.rows.reduce<number>((sum, row) => sum + row.reduce<number>((inner, value) => inner + String(value ?? "").length, 0), 0) > contentLimit) throw new Error(`Spreadsheet edit exceeds the ${contentLimit} character limit`);
  const { default: JSZip } = await import("jszip"); const zip = await JSZip.loadAsync(original);
  const selected = await xlsxWorksheet(zip, args.sheet); let worksheetXml = selected.xml; let affected: string[] = [];
  if (args.operation === "set_cell") {
    const target = parseCellAddress(args.cell!); const result = setWorksheetCell(worksheetXml, target.address, args.value!);
    if (result.replacedFormula) throw new Error(`Cell ${target.address} contains a formula; formula replacement is not supported by office_edit`);
    worksheetXml = result.xml; affected = [target.address];
  } else if (args.operation === "set_formula") {
    const target = parseCellAddress(args.cell!); worksheetXml = setWorksheetFormula(worksheetXml, target.address, args.formula!); affected = [target.address];
  } else {
    const bounds = worksheetBounds(worksheetXml); let nextRow = bounds.maxRow + 1;
    const sheetData = worksheetXml.match(/<sheetData\b([^>]*)>([\s\S]*?)<\/sheetData\s*>/); const emptySheetData = worksheetXml.match(/<sheetData\b([^>]*)\s*\/\s*>/);
    if (!sheetData && !emptySheetData) throw new Error("Worksheet XML is missing sheetData");
    const appended = args.rows!.map((row) => {
      if (nextRow > 1_048_576) throw new Error("Appending rows would exceed the XLSX worksheet limit");
      const rowXml = `<row r="${nextRow}">${row.map((value, index) => spreadsheetCellXml(value, `${columnName(index + 1)}${nextRow}`, false)).join("")}</row>`;
      affected.push(`${columnName(1)}${nextRow}:${columnName(row.length)}${nextRow}`); nextRow++; return rowXml;
    }).join("");
    worksheetXml = sheetData ? worksheetXml.replace(sheetData[0], `<sheetData${sheetData[1]}>${sheetData[2]}${appended}</sheetData>`) : worksheetXml.replace(emptySheetData![0], `<sheetData${emptySheetData![1]}>${appended}</sheetData>`);
    worksheetXml = updateWorksheetDimension(worksheetXml, `A${nextRow - 1}`);
    const lastRow = nextRow - 1; const lastColumn = Math.max(bounds.maxColumn, ...args.rows!.map((row) => row.length));
    worksheetXml = worksheetXml.replace(/<autoFilter\b([^>]*\bref=")([^"]+)("[^>]*\/?\s*>)/, (_all, before: string, filterRef: string, after: string) => {
      const start = filterRef.split(":")[0] ?? "A1"; return `<autoFilter${before}${start}:${columnName(lastColumn)}${Math.max(lastRow, parseCellAddress(filterRef.split(":").at(-1) ?? start).row)}${after}`;
    });
  }
  zip.file(selected.path, worksheetXml);
  const rawOutput = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const recalculated = await worksheetHasFormulas(zip) ? await recalculateFormulaCaches(rawOutput) : undefined;
  const output = recalculated?.bytes ?? rawOutput;
  const current = await readFile(path); if (createHash("sha256").update(current).digest("hex") !== originalHash) throw new Error("File changed while the XLSX edit was being prepared; reload it before editing");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, output, { flag: "wx" }); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { path, sha256: createHash("sha256").update(output).digest("hex"), operation: args.operation, sheet: selected.name, affected, ...(recalculated ? { recalculation: recalculated.report } : {}) };
}

function replaceDocxText(documentXml: string, findText: string, replaceText: string): { xml: string; matches: number } {
  let matches = 0; let updatedXml = documentXml;
  const paragraphs = [...documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p\s*>/g)];
  for (const paragraphMatch of paragraphs) {
    const paragraph = paragraphMatch[0];
    const textNodes = [...paragraph.matchAll(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t\s*>)/g)].map((match) => ({ start: match.index!, end: match.index! + match[0].length, open: match[1]!, close: match[3]!, value: decodeXml(match[2]!) }));
    const joined = textNodes.map((node) => node.value).join("");
    let at = joined.indexOf(findText);
    if (at < 0) continue;
    const occurrences: number[] = [];
    while (at >= 0) { occurrences.push(at); at = joined.indexOf(findText, at + Math.max(1, findText.length)); }
    if (occurrences.length > 1) { matches += occurrences.length; continue; }
    const matchStart = occurrences[0]!; const matchEnd = matchStart + findText.length;
    let offset = 0; let first = -1; let last = -1; let firstInner = 0; let lastInner = 0;
    for (let index = 0; index < textNodes.length; index++) {
      const node = textNodes[index]!; const nodeStart = offset; const nodeEnd = offset + node.value.length; offset = nodeEnd;
      if (first < 0 && matchStart < nodeEnd) { first = index; firstInner = matchStart - nodeStart; }
      if (matchEnd <= nodeEnd) { last = index; lastInner = matchEnd - nodeStart; break; }
    }
    if (first < 0 || last < 0) continue;
    if (first !== last) {
      const gap = paragraph.slice(textNodes[first]!.end, textNodes[last]!.start);
      if (/<w:(?:tab|br|drawing|object|fldChar|instrText|delText)\b/i.test(gap)) continue;
    }
    matches++;
    if (matches > 1) continue;
    const replacements = textNodes.map((node) => node.value);
    if (first === last) replacements[first] = replacements[first]!.slice(0, firstInner) + replaceText + replacements[first]!.slice(lastInner);
    else {
      replacements[first] = replacements[first]!.slice(0, firstInner) + replaceText;
      for (let index = first + 1; index < last; index++) replacements[index] = "";
      replacements[last] = replacements[last]!.slice(lastInner);
    }
    let nodeIndex = 0;
    const changedParagraph = paragraph.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t\s*>)/g, (_whole, open: string, _old: string, close: string) => {
      const value = replacements[nodeIndex++]!; const escaped = xml(value);
      const withSpace = /(?:^\s|\s$)/.test(value) && !/\bxml:space\s*=/.test(open) ? open.replace(/>$/, ' xml:space="preserve">') : open;
      return `${withSpace}${escaped}${close}`;
    });
    updatedXml = updatedXml.replace(paragraph, changedParagraph);
  }
  return { xml: updatedXml, matches };
}

function extractDocxText(documentXml: string): string {
  return [...documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p\s*>/g)].map(([paragraph]) => [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>/g)].map((match) => decodeXml(match[1]!)).join("")).join("\n");
}

function pptxSlideParts(zip: any): Array<{ number: number; path: string }> {
  return Object.keys(zip.files as Record<string, unknown>).flatMap((path) => {
    const match = path.match(/^ppt\/slides\/slide([1-9]\d*)\.xml$/);
    return match && !zip.files[path]?.dir ? [{ number: Number(match[1]), path }] : [];
  }).sort((a, b) => a.number - b.number);
}

function extractPptxText(slideXml: string): string {
  return [...slideXml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p\s*>/g)].map(([paragraph]) =>
    [...paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t\s*>/g)].map((match) => decodeXml(match[1]!)).join("")
  ).filter(Boolean).join("\n");
}

function replacePptxText(slideXml: string, findText: string, replaceText: string): { xml: string; matches: number } {
  let matches = 0; let updatedXml = slideXml;
  const paragraphs = [...slideXml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p\s*>/g)];
  for (const paragraphMatch of paragraphs) {
    const paragraph = paragraphMatch[0];
    const textNodes = [...paragraph.matchAll(/(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t\s*>)/g)].map((match) => ({ start: match.index!, end: match.index! + match[0].length, open: match[1]!, close: match[3]!, value: decodeXml(match[2]!) }));
    const joined = textNodes.map((node) => node.value).join(""); let at = joined.indexOf(findText); const occurrences: number[] = [];
    while (at >= 0) { occurrences.push(at); at = joined.indexOf(findText, at + Math.max(1, findText.length)); }
    if (!occurrences.length) continue;
    if (occurrences.length > 1) { matches += occurrences.length; continue; }
    const matchStart = occurrences[0]!; const matchEnd = matchStart + findText.length;
    let offset = 0; let first = -1; let last = -1; let firstInner = 0; let lastInner = 0;
    for (let index = 0; index < textNodes.length; index++) {
      const node = textNodes[index]!; const nodeStart = offset; const nodeEnd = offset + node.value.length; offset = nodeEnd;
      if (first < 0 && matchStart < nodeEnd) { first = index; firstInner = matchStart - nodeStart; }
      if (matchEnd <= nodeEnd) { last = index; lastInner = matchEnd - nodeStart; break; }
    }
    if (first < 0 || last < 0) continue;
    if (first !== last && /<a:(?:br|tab|fld|noBreakHyphen|softHyphen)\b/i.test(paragraph.slice(textNodes[first]!.end, textNodes[last]!.start))) continue;
    matches++;
    if (matches > 1) continue;
    const replacements = textNodes.map((node) => node.value);
    if (first === last) replacements[first] = replacements[first]!.slice(0, firstInner) + replaceText + replacements[first]!.slice(lastInner);
    else {
      replacements[first] = replacements[first]!.slice(0, firstInner) + replaceText;
      for (let index = first + 1; index < last; index++) replacements[index] = "";
      replacements[last] = replacements[last]!.slice(lastInner);
    }
    let nodeIndex = 0;
    const changedParagraph = paragraph.replace(/(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t\s*>)/g, (_whole, open: string, _old: string, close: string) => {
      const value = replacements[nodeIndex++]!; const escaped = xml(value);
      const withSpace = /(?:^\s|\s$)/.test(value) && !/\bxml:space\s*=/.test(open) ? open.replace(/>$/, ' xml:space="preserve">') : open;
      return `${withSpace}${escaped}${close}`;
    });
    updatedXml = updatedXml.replace(paragraph, changedParagraph);
  }
  return { xml: updatedXml, matches };
}

function assertPptxZipLimits(zip: { files: Record<string, unknown> }): void {
  const sizes = Object.entries(zip.files).map(([name, file]) => ({ name, size: (file as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0 }));
  if (sizes.reduce((sum, file) => sum + file.size, 0) > 150 * 1024 * 1024) throw new Error("PPTX package expands beyond the 150 MiB safety limit");
  if (sizes.some((file) => file.name.startsWith("ppt/slides/slide") && file.name.endsWith(".xml") && file.size > 20 * 1024 * 1024)) throw new Error("PPTX slide XML exceeds the 20 MiB processing limit");
}

function assertDocxZipLimits(zip: { files: Record<string, unknown> }): void {
  const sizes = Object.entries(zip.files).map(([name, file]) => ({ name, size: (file as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0 }));
  const total = sizes.reduce((sum, file) => sum + file.size, 0);
  if (total > 150 * 1024 * 1024) throw new Error("DOCX package expands beyond the 150 MiB safety limit");
  if ((sizes.find((file) => file.name === "word/document.xml")?.size ?? 0) > 20 * 1024 * 1024) throw new Error("DOCX main document XML exceeds the 20 MiB processing limit");
}

async function readDocx(access: AccessController, path: string, maxChars: number): Promise<{ path: string; sha256: string; text: string; truncated: boolean; trust: "untrusted-file-content" }> {
  path = await access.assertPath(path, "read");
  const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("DOCX reading is limited to files under 50 MiB");
  const { default: JSZip } = await import("jszip"); const zip = await JSZip.loadAsync(original); assertDocxZipLimits(zip);
  const document = zip.file("word/document.xml"); if (!document) throw new Error("DOCX package is missing word/document.xml");
  const fullText = extractDocxText(await document.async("string"));
  return { path, sha256: createHash("sha256").update(original).digest("hex"), text: fullText.slice(0, maxChars), truncated: fullText.length > maxChars, trust: "untrusted-file-content" };
}

async function editDocx(access: AccessController, path: string, expectedHash: string, findText: string, replaceText: string): Promise<{ path: string; sha256: string; replacements: number }> {
  path = await access.assertPath(path, "read"); path = await access.assertPath(path, "write");
  const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("DOCX editing is limited to files under 50 MiB");
  const hash = createHash("sha256").update(original).digest("hex");
  if (hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("File changed since it was read; reload it before editing");
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(original); assertDocxZipLimits(zip);
  const document = zip.file("word/document.xml"); if (!document) throw new Error("DOCX package is missing word/document.xml");
  const documentXml = await document.async("string");
  const edited = replaceDocxText(documentXml, findText, replaceText);
  if (!edited.matches) throw new Error("Text was not found as a unique phrase within one paragraph of the DOCX body");
  if (edited.matches > 1) throw new Error("Text occurs more than once in the DOCX body; include more context");
  zip.file("word/document.xml", edited.xml);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const current = await readFile(path);
  if (createHash("sha256").update(current).digest("hex") !== hash) throw new Error("File changed while the DOCX edit was being prepared; reload it before editing");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, output, { flag: "wx" }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return { path, sha256: createHash("sha256").update(output).digest("hex"), replacements: 1 };
}

async function readPptx(access: AccessController, path: string, maxChars: number): Promise<Record<string, unknown>> {
  path = await access.assertPath(path, "read"); const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("PPTX reading is limited to files under 50 MiB");
  const { default: JSZip } = await import("jszip"); const zip = await JSZip.loadAsync(original); assertPptxZipLimits(zip);
  const parts = pptxSlideParts(zip); if (!parts.length) throw new Error("PPTX package contains no slide XML");
  const slides: Array<{ slide: number; text: string }> = []; let remaining = maxChars; let truncated = false;
  for (const part of parts) {
    const file = zip.file(part.path); if (!file) continue;
    const text = extractPptxText(await file.async("string"));
    if (text.length > remaining) { slides.push({ slide: part.number, text: text.slice(0, remaining) }); remaining = 0; truncated = true; break; }
    slides.push({ slide: part.number, text }); remaining -= text.length;
  }
  return { path, sha256: createHash("sha256").update(original).digest("hex"), slides, text: slides.map(({ slide, text }) => `Slide ${slide}\n${text}`).join("\n\n"), truncated, trust: "untrusted-file-content" };
}

async function editPptx(access: AccessController, args: z.infer<typeof pptxEditSchema>, path: string): Promise<Record<string, unknown>> {
  path = await access.assertPath(path, "read"); path = await access.assertPath(path, "write"); const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("PPTX editing is limited to files under 50 MiB");
  const originalHash = createHash("sha256").update(original).digest("hex");
  if (originalHash.toLowerCase() !== args.expected_sha256.toLowerCase()) throw new Error("File changed since it was read; reload it before editing");
  const { default: JSZip } = await import("jszip"); const zip = await JSZip.loadAsync(original); assertPptxZipLimits(zip);
  let matches = 0; let affectedSlide: number | undefined;
  for (const part of pptxSlideParts(zip)) {
    const file = zip.file(part.path); if (!file) continue;
    const result = replacePptxText(await file.async("string"), args.find_text, args.replace_text); matches += result.matches;
    if (result.matches) { affectedSlide = part.number; zip.file(part.path, result.xml); }
  }
  if (!matches) throw new Error("Text was not found as a unique phrase within one paragraph of the PPTX slides");
  if (matches > 1) throw new Error("Text occurs more than once in the PPTX slides; include more context");
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (createHash("sha256").update(await readFile(path)).digest("hex") !== originalHash) throw new Error("File changed while the PPTX edit was being prepared; reload it before editing");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, output, { flag: "wx" }); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { path, sha256: createHash("sha256").update(output).digest("hex"), replacements: 1, slide: affectedSlide };
}

const pdfByteLimit = 50 * 1024 * 1024;
const pdfPageLimit = 1000;
const pdfOcrPageLimit = 10;
const pdfOcrPixelLimit = 4_000_000;
const pdfPreviewPixelLimit = 4_000_000;

type PdfExtractedPage = { page: number; text: string; method: "text" | "ocr" | "empty" | "ocr_skipped" };

export const supportedPdfOcrLanguages = ["eng", "fra", "deu", "spa"] as const;
export type PdfOcrLanguage = typeof supportedPdfOcrLanguages[number];

export function validatePdfOcrLanguages(value: unknown): PdfOcrLanguage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > supportedPdfOcrLanguages.length || value.some((item) => !supportedPdfOcrLanguages.includes(item as PdfOcrLanguage)) || new Set(value).size !== value.length) {
    throw new Error(`PDF OCR languages must be a unique array containing 1–${supportedPdfOcrLanguages.length} of: ${supportedPdfOcrLanguages.join(", ")}`);
  }
  return value as PdfOcrLanguage[];
}

async function createOfflineOcrWorker(languages: PdfOcrLanguage[]): Promise<{ worker: any; cleanup(): Promise<void> }> {
  const require = createRequire(import.meta.url);
  const languagePaths = languages.map((language) => resolve(dirname(require.resolve(`@tesseract.js-data/${language}/package.json`) as string), "4.0.0_best_int"));
  let tempLanguagePath: string | undefined;
  let languagePath = languagePaths[0]!;
  if (languages.length > 1) {
    tempLanguagePath = await mkdtemp(join(tmpdir(), "xyst-ocr-"));
    try {
      for (let index = 0; index < languages.length; index++) await copyFile(join(languagePaths[index]!, `${languages[index]}.traineddata.gz`), join(tempLanguagePath, `${languages[index]}.traineddata.gz`));
    } catch (error) { await rm(tempLanguagePath, { recursive: true, force: true }); throw error; }
    languagePath = tempLanguagePath;
  }
  const { createWorker } = await import("tesseract.js");
  try {
    const worker = await createWorker(languages.join("+"), 1, { langPath: languagePath, gzip: true, cacheMethod: "none", logger: () => {} });
    return { worker, cleanup: async () => { if (tempLanguagePath) await rm(tempLanguagePath, { recursive: true, force: true }); } };
  } catch (error) { if (tempLanguagePath) await rm(tempLanguagePath, { recursive: true, force: true }); throw error; }
}

async function recognizePdfPage(page: any, worker: any, canvasFactory: any): Promise<string> {
  const baseViewport = page.getViewport({ scale: 1 });
  const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
  const scale = Math.min(2, Math.sqrt(pdfOcrPixelLimit / basePixels));
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width)); const height = Math.max(1, Math.ceil(viewport.height));
  if (width * height > pdfOcrPixelLimit + width + height) throw new Error("PDF page exceeds the OCR pixel limit");
  const canvasEntry = canvasFactory.create(width, height);
  try {
    await page.render({ canvasContext: canvasEntry.context, viewport }).promise;
    const result = await worker.recognize(canvasEntry.canvas.toBuffer("image/png"));
    return String(result.data.text ?? "").trim();
  } finally { canvasFactory.destroy(canvasEntry); }
}

async function renderPdfPagePng(bytes: Uint8Array, pageNumber: number): Promise<{ png: Uint8Array; width: number; height: number; pageCount: number }> {
  if (bytes.byteLength > pdfByteLimit) throw new Error("PDF preview is limited to files under 50 MiB");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages > pdfPageLimit) throw new Error("PDF preview is limited to documents under 1000 pages");
    if (pageNumber > document.numPages) throw new Error(`PDF page ${pageNumber} does not exist`);
    const page = await document.getPage(pageNumber);
    try {
      const baseViewport = page.getViewport({ scale: 1 });
      const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
      const scale = Math.min(2, Math.sqrt(pdfPreviewPixelLimit / basePixels));
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width)); const height = Math.max(1, Math.ceil(viewport.height));
      if (width * height > pdfPreviewPixelLimit + width + height) throw new Error("PDF page exceeds the visual preview pixel limit");
      const canvasFactory = document.canvasFactory as any;
      const canvasEntry = canvasFactory.create(width, height);
      try {
        await (page as any).render({ canvasContext: canvasEntry.context, viewport }).promise;
        return { png: canvasEntry.canvas.toBuffer("image/png"), width, height, pageCount: document.numPages };
      } finally { canvasFactory.destroy(canvasEntry); }
    } finally { page.cleanup(); }
  } finally { await task.destroy(); }
}

async function convertOfficeDocumentToPdf(sourcePath: string, rendererExecutable: string, access: AccessController, signal?: AbortSignal): Promise<Uint8Array> {
  const format = extname(sourcePath).toLowerCase();
  const filter = format === ".docx" ? "writer_pdf_Export" : format === ".xlsx" ? "calc_pdf_Export" : format === ".pptx" ? "impress_pdf_Export" : undefined;
  if (!filter) throw new Error("Office preview supports DOCX, XLSX, and PPTX sources");
  const source = await readFile(sourcePath);
  if (source.byteLength > pdfByteLimit) throw new Error("Office preview is limited to source files under 50 MiB");
  const tempDirectory = await mkdtemp(join(tmpdir(), "xyst-office-preview-"));
  try {
    const profileUrl = pathToFileURL(join(tempDirectory, "profile")).href;
    access.assertExecutable(rendererExecutable);
    let result;
    try {
      result = await runProcess(rendererExecutable, ["--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore", `-env:UserInstallation=${profileUrl}`, "--convert-to", `pdf:${filter}`, "--outdir", tempDirectory, sourcePath], { cwd: tempDirectory, timeoutMs: 120_000, maxOutputChars: 4000, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not start the configured office renderer (${rendererExecutable}). Install LibreOffice or set documents.officeRendererExecutable to its soffice executable path. ${detail}`);
    }
    if (result.code !== 0 || result.signal) throw new Error(`LibreOffice could not convert ${format.slice(1).toUpperCase()} to PDF: ${(result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 2000)}`);
    const pdfPath = join(tempDirectory, `${basename(sourcePath, format)}.pdf`);
    let pdf: Buffer;
    try { pdf = await readFile(pdfPath); }
    catch { throw new Error(`LibreOffice returned without creating a PDF${result.stderr ? `: ${result.stderr.trim().slice(0, 1000)}` : ""}`); }
    if (pdf.byteLength > pdfByteLimit) throw new Error("Converted office preview exceeds the 50 MiB PDF limit");
    return pdf;
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
}

async function extractPdfPages(bytes: Uint8Array, maxChars: number, configuredLanguages: unknown = ["eng"]): Promise<{ pages: PdfExtractedPage[]; pageCount: number; truncated: boolean; ocrPages: number; ocrLimitReached: boolean; ocrLanguages: PdfOcrLanguage[] }> {
  const ocrLanguages = validatePdfOcrLanguages(configuredLanguages);
  if (bytes.byteLength > pdfByteLimit) throw new Error("PDF reading is limited to files under 50 MiB");
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
  let worker: any; let workerCleanup: (() => Promise<void>) | undefined;
  try {
    const document = await task.promise; const limit = Math.min(document.numPages, pdfPageLimit);
    const pages: PdfExtractedPage[] = []; let remaining = maxChars; let truncated = document.numPages > limit; let ocrPages = 0; let ocrLimitReached = false;
    for (let number = 1; number <= limit && remaining > 0; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        let pageText = content.items.flatMap((item: any) => typeof item.str === "string" ? [item.str, item.hasEOL ? "\n" : " "] : []).join("").replace(/[ \t]+\n/g, "\n").trim();
        let method: PdfExtractedPage["method"] = pageText ? "text" : "empty";
        const operatorList = pageText.length < 60 ? await page.getOperatorList() : undefined;
        const hasRasterImage = operatorList?.fnArray.some((operator: number) => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat].includes(operator)) ?? false;
        if (pageText.length < 60 && hasRasterImage) {
          if (ocrPages < pdfOcrPageLimit) {
            if (!worker) { const prepared = await createOfflineOcrWorker(ocrLanguages); worker = prepared.worker; workerCleanup = prepared.cleanup; }
            const recognized = await recognizePdfPage(page, worker, document.canvasFactory);
            if (recognized) { pageText = recognized; method = "ocr"; }
            ocrPages++;
          } else { method = "ocr_skipped"; ocrLimitReached = true; }
        }
        if (pageText.length > remaining) { pages.push({ page: number, text: pageText.slice(0, remaining), method }); remaining = 0; truncated = true; break; }
        pages.push({ page: number, text: pageText, method }); remaining -= pageText.length;
      } finally { page.cleanup(); }
    }
    if (remaining === 0 && pages.at(-1)?.text.length) truncated = true;
    return { pages, pageCount: document.numPages, truncated, ocrPages, ocrLimitReached, ocrLanguages };
  } finally {
    try { if (worker) await worker.terminate(); }
    finally {
      try { await workerCleanup?.(); }
      finally { await task.destroy(); }
    }
  }
}

async function readPdf(access: AccessController, path: string, maxChars: number, ocrLanguages: PdfOcrLanguage[]): Promise<Record<string, unknown>> {
  path = await access.assertPath(path, "read"); const original = await readFile(path);
  const extracted = await extractPdfPages(original, maxChars, ocrLanguages);
  return { path, sha256: createHash("sha256").update(original).digest("hex"), ...extracted, text: extracted.pages.map(({ page, text }) => `Page ${page}\n${text}`).join("\n\n"), trust: "untrusted-file-content" };
}

export async function extractPdfAttachmentText(bytes: Uint8Array, maxChars = 30_000, configuredLanguages: unknown = ["eng"]): Promise<{ text: string; pageCount: number; truncated: boolean; ocrPages: number; ocrLimitReached: boolean; ocrLanguages: PdfOcrLanguage[] }> {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1000 || maxChars > 30_000) throw new Error("PDF attachment text limit must be between 1,000 and 30,000 characters");
  const extracted = await extractPdfPages(bytes, maxChars, configuredLanguages);
  return { text: extracted.pages.filter(({ text }) => text.trim()).map(({ page, text }) => `Page ${page}\n${text}`).join("\n\n"), pageCount: extracted.pageCount, truncated: extracted.truncated, ocrPages: extracted.ocrPages, ocrLimitReached: extracted.ocrLimitReached, ocrLanguages: extracted.ocrLanguages };
}

async function editPdf(access: AccessController, args: z.infer<typeof pdfEditSchema>, path: string): Promise<Record<string, unknown>> {
  path = await access.assertPath(path, "read"); path = await access.assertPath(path, "write"); const original = await readFile(path);
  if (original.byteLength > 50 * 1024 * 1024) throw new Error("PDF editing is limited to files under 50 MiB");
  const originalHash = createHash("sha256").update(original).digest("hex");
  if (originalHash.toLowerCase() !== args.expected_sha256.toLowerCase()) throw new Error("File changed since it was read; reload it before editing");
  const { PDFDocument, StandardFonts } = await import("pdf-lib"); const document = await PDFDocument.load(original);
  if (document.getPageCount() > 1000) throw new Error("PDF editing is limited to documents under 1000 pages");
  if (args.page > document.getPageCount()) throw new Error(`PDF page ${args.page} does not exist`);
  const page = document.getPage(args.page - 1); const { width, height } = page.getSize(); const fontSize = args.font_size ?? 12;
  const font = await document.embedFont(StandardFonts.Helvetica);
  let textWidth: number;
  try { textWidth = font.widthOfTextAtSize(args.text, fontSize); }
  catch { throw new Error("PDF append_text supports text encodable in the standard Helvetica font (WinAnsi)"); }
  const x = args.x ?? 50; const y = args.y ?? Math.max(20, height - 60);
  if (x + textWidth > width || y + fontSize > height) throw new Error("PDF text position and size must fit within the selected page");
  try { page.drawText(args.text, { x, y, size: fontSize, font }); }
  catch { throw new Error("PDF append_text supports text encodable in the standard Helvetica font (WinAnsi)"); }
  const output = await document.save();
  if (createHash("sha256").update(await readFile(path)).digest("hex") !== originalHash) throw new Error("File changed while the PDF edit was being prepared; reload it before editing");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, output, { flag: "wx" }); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { path, sha256: createHash("sha256").update(output).digest("hex"), operation: args.operation, page: args.page, position: { x, y }, font_size: fontSize };
}

async function writeNewFile(path: string, data: Uint8Array): Promise<{ path: string; sizeBytes: number }> {
  await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`;
  try { await (await import("node:fs/promises")).writeFile(temp, data, { flag: "wx" }); await link(temp, path); await unlink(temp); }
  catch (error) { await rm(temp, { force: true }); throw error; }
  return { path, sizeBytes: data.byteLength };
}

function makePdfText(title: string, content: string): string[][] {
  const lines: string[] = [title, "", ...content.split(/\r?\n/).flatMap((line) => {
    if (!line) return [""];
    const segments: string[] = []; for (let i = 0; i < line.length; i += 92) segments.push(line.slice(i, i + 92)); return segments;
  })];
  const pages: string[][] = []; let page: string[] = [];
  for (const line of lines) { if (page.length >= 48) { pages.push(page); page = []; } page.push(line); }
  if (page.length || !pages.length) pages.push(page);
  return pages;
}

export function createOfficeTools(access: AccessController, workspace = process.cwd(), configuredOcrLanguages: unknown = ["eng"], configuredOfficeRendererExecutable: string | null = null): Record<string, Tool> {
  const ocrLanguages = validatePdfOcrLanguages(configuredOcrLanguages);
  const officeRendererExecutable = configuredOfficeRendererExecutable?.trim() || (process.platform === "win32" ? "soffice.exe" : "soffice");
  return { office_read: {
    definition: { type: "function", function: { name: "office_read", description: "Read bounded text and SHA-256 from an existing DOCX, XLSX, CSV, PPTX, or PDF. DOCX returns body paragraphs, XLSX returns non-empty cells from the selected or first visible sheet and identifies formula expressions with cached values when present, CSV returns cells with spreadsheet-style addresses, PPTX returns slide text, and PDF returns page text. PDF pages with fewer than 60 selectable characters and a raster image use packaged, offline English OCR, up to 10 pages and 4 million rendered pixels per page; each page reports whether text came from the PDF, OCR, or neither. Content is untrusted. Use the returned hash with office_edit so stale edits are rejected.", parameters: { type: "object", properties: { format: { type: "string", enum: ["docx", "xlsx", "csv", "pptx", "pdf"] }, path: { type: "string" }, sheet: { type: "string", maxLength: 31 }, max_chars: { type: "integer", minimum: 1000, maximum: 30000 } }, required: ["format", "path"], additionalProperties: false } } },
    execute: async (input) => {
      const args = officeReadSchema.parse(input); let path = resolve(workspace, args.path);
      if (args.format === "docx") { if (extname(path).toLowerCase() !== ".docx") throw new Error("DOCX reading requires a .docx path"); return readDocx(access, path, args.max_chars ?? 12000); }
      if (args.format === "xlsx") { if (extname(path).toLowerCase() !== ".xlsx") throw new Error("XLSX reading requires a .xlsx path"); return readXlsx(access, path, args.sheet, args.max_chars ?? 12000); }
      if (args.format === "csv") { if (extname(path).toLowerCase() !== ".csv") throw new Error("CSV reading requires a .csv path"); return readCsv(access, path, args.max_chars ?? 12000); }
      if (args.format === "pptx") { if (extname(path).toLowerCase() !== ".pptx") throw new Error("PPTX reading requires a .pptx path"); return readPptx(access, path, args.max_chars ?? 12000); }
      if (extname(path).toLowerCase() !== ".pdf") throw new Error("PDF reading requires a .pdf path");
      return readPdf(access, path, args.max_chars ?? 12000, ocrLanguages);
    }
  }, office_edit: {
    definition: { type: "function", function: { name: "office_edit", description: "Edit an existing DOCX, XLSX, PPTX, or PDF using the SHA-256 from office_read. DOCX and PPTX replace one unique text phrase; PDF supports appending text to a specified page; XLSX supports text or formula cell edits and appending typed rows. Formula edits recalculate workbook caches; unsupported formulas, external links, and incompatible workbook features are reported by the evaluator. Unchanged package parts are preserved where applicable.", parameters: { type: "object", properties: { format: { type: "string", enum: ["docx", "xlsx", "pptx", "pdf"] }, path: { type: "string" }, expected_sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" }, find_text: { type: "string", minLength: 1, maxLength: 20000 }, replace_text: { type: "string", maxLength: 20000 }, operation: { type: "string", enum: ["set_cell", "set_formula", "append_rows", "append_text"] }, sheet: { type: "string", maxLength: 31 }, cell: { type: "string", pattern: "^\\$?[A-Za-z]{1,3}\\$?[1-9][0-9]{0,6}$" }, value: { type: "string", maxLength: 20000 }, formula: { type: "string", minLength: 2, maxLength: 20000, pattern: "^=" }, rows: { type: "array", maxItems: 1000, items: { type: "array", minItems: 1, maxItems: 100, items: { anyOf: [{ type: "string", maxLength: 20000 }, { type: "number" }, { type: "boolean" }, { type: "null" }] } } }, page: { type: "integer", minimum: 1, maximum: 1000 }, text: { type: "string", minLength: 1, maxLength: 2000 }, x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 }, font_size: { type: "number", minimum: 6, maximum: 72 } }, required: ["format", "path", "expected_sha256"], additionalProperties: false } } },
    execute: async (input) => {
      const args = officeEditSchema.parse(input); let path = resolve(workspace, args.path);
      path = await access.assertPath(path, "read");
      if (args.format === "docx") { if (extname(path).toLowerCase() !== ".docx") throw new Error("DOCX edits require a .docx path"); return editDocx(access, path, args.expected_sha256, args.find_text, args.replace_text); }
      if (args.format === "pptx") { if (extname(path).toLowerCase() !== ".pptx") throw new Error("PPTX edits require a .pptx path"); return editPptx(access, args, path); }
      if (args.format === "pdf") { if (extname(path).toLowerCase() !== ".pdf") throw new Error("PDF edits require a .pdf path"); return editPdf(access, args, path); }
      if (extname(path).toLowerCase() !== ".xlsx") throw new Error("XLSX edits require a .xlsx path");
      return editXlsx(access, args, path);
    }
  }, office_preview: {
    definition: { type: "function", function: { name: "office_preview", description: "Render one page of a PDF, DOCX, XLSX, or PPTX into a PNG preview artifact. Office formats use an installed LibreOffice renderer; set documents.officeRendererExecutable to its soffice path if it is not on PATH. Source and output paths are checked against the active access profile, existing outputs are never overwritten, conversion time is limited to 120 seconds, and rendering is bounded to 4 million pixels.", parameters: { type: "object", properties: { path: { type: "string", minLength: 1 }, page: { type: "integer", minimum: 1, maximum: pdfPageLimit }, output_path: { type: "string", minLength: 1 } }, required: ["path", "page", "output_path"], additionalProperties: false } } },
    execute: async (input, signal) => {
      const args = z.object({ path: z.string().min(1), page: z.number().int().min(1).max(pdfPageLimit), output_path: z.string().min(1) }).strict().parse(input);
      const sourcePath = await access.assertPath(resolve(workspace, args.path), "read");
      const outputPath = await access.assertPath(resolve(workspace, args.output_path), "write");
      const sourceFormat = extname(sourcePath).toLowerCase();
      if (![".pdf", ".docx", ".xlsx", ".pptx"].includes(sourceFormat)) throw new Error("Office preview requires a PDF, DOCX, XLSX, or PPTX source file");
      if (extname(outputPath).toLowerCase() !== ".png") throw new Error("PDF preview output path must end in .png");
      if (sourcePath === outputPath) throw new Error("Office preview output must be a separate PNG file");
      const source = await readFile(sourcePath);
      const hash = createHash("sha256").update(source).digest("hex");
      const pdf = sourceFormat === ".pdf" ? source : await convertOfficeDocumentToPdf(sourcePath, officeRendererExecutable, access, signal);
      const rendered = await renderPdfPagePng(pdf, args.page);
      const saved = await writeNewFile(outputPath, rendered.png);
      return { ...saved, sha256: createHash("sha256").update(rendered.png).digest("hex"), source_path: sourcePath, source_sha256: hash, source_format: sourceFormat.slice(1), ...(sourceFormat === ".pdf" ? {} : { renderer: officeRendererExecutable }), page: args.page, page_count: rendered.pageCount, width: rendered.width, height: rendered.height, mime_type: "image/png" };
    }
  }, office_create: {
    definition: { type: "function", function: { name: "office_create", description: "Create a new DOCX, XLSX, CSV, PDF, or PPTX artifact in the workspace. For DOCX/PDF, title is rendered as the document heading. If content starts with that same heading, it is removed once by default; set repeat_title=true only when an intentional repeated heading is required. Provide content for DOCX/PDF, typed rows (including a header row) for XLSX/CSV, or titled slides for PPTX. XLSX strings beginning with = are formulas and are recalculated; use numbers and booleans for typed spreadsheet values. Formula compatibility follows Formualizer's documented subset, and unsupported formulas are reported. Existing files are never overwritten; inspect generated layout-sensitive documents using an available viewer before reporting them as visually verified.", parameters: { type: "object", properties: { format: { type: "string", enum: ["docx", "xlsx", "csv", "pptx", "pdf"] }, path: { type: "string" }, title: { type: "string", maxLength: 200 }, content: { type: "string", maxLength: contentLimit }, repeat_title: { type: "boolean" }, rows: { type: "array", maxItems: 1000, items: { type: "array", minItems: 1, maxItems: 100, items: { anyOf: [{ type: "string", maxLength: 20000 }, { type: "number" }, { type: "boolean" }, { type: "null" }] } } }, slides: { type: "array", maxItems: 60, items: { type: "object", properties: { title: { type: "string", maxLength: 200 }, body: { type: "string", maxLength: 20000 } }, required: ["title", "body"], additionalProperties: false } } }, required: ["format", "path", "title"], additionalProperties: false } } },
    execute: async (input) => {
      const args = schema.parse(input); let path = resolve(workspace, args.path);
      const totalRowsChars = args.rows?.reduce<number>((sum, row) => sum + row.reduce<number>((inner, value) => inner + String(value ?? "").length, 0), 0) ?? 0;
      const totalSlideChars = args.slides?.reduce((sum, slide) => sum + slide.title.length + slide.body.length, 0) ?? 0;
      if (totalRowsChars > contentLimit || totalSlideChars > contentLimit) throw new Error(`Structured document content exceeds the ${contentLimit} character limit`);
      const expectedExtension = `.${args.format}`;
      if (extname(path).toLowerCase() !== expectedExtension) throw new Error(`Output path must end in ${expectedExtension}`);
      path = await access.assertPath(path, "write");
      const content = args.content === undefined ? undefined : removeLeadingDuplicateTitle(args.title, args.content, args.repeat_title);
      let bytes: Uint8Array; let recalculation: FormulaRecalculation | undefined;
      if (args.format === "docx") {
        if (content === undefined) throw new Error("DOCX creation requires content");
        const { Document, HeadingLevel, Packer, Paragraph } = await import("docx");
        const body = content.split(/\r?\n/).map((text) => new Paragraph({ text: text || " " }));
        bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: args.title, heading: HeadingLevel.HEADING_1 }), ...body] }] }));
      } else if (args.format === "xlsx") {
        if (!args.rows?.length) throw new Error("XLSX creation requires rows including a header row");
        bytes = await spreadsheetXml(args.rows, args.title);
        if (args.rows.some((row) => row.some((value) => typeof value === "string" && value.startsWith("=")))) {
          const result = await recalculateFormulaCaches(bytes); bytes = result.bytes; recalculation = result.report;
        }
      } else if (args.format === "csv") {
        if (!args.rows?.length) throw new Error("CSV creation requires rows including a header row");
        bytes = new TextEncoder().encode(csvText(args.rows));
      } else if (args.format === "pdf") {
        if (content === undefined) throw new Error("PDF creation requires content");
        const { PDFDocument, StandardFonts } = await import("pdf-lib"); const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
        for (const [pageIndex, lines] of makePdfText(args.title, content).entries()) {
          const page = pdf.addPage([612, 792]); let y = 744;
          for (const [lineIndex, line] of lines.entries()) { page.drawText(line, { x: 50, y, size: pageIndex === 0 && lineIndex === 0 ? 18 : 11, font: pageIndex === 0 && lineIndex === 0 ? bold : font, maxWidth: 512 }); y -= pageIndex === 0 && lineIndex === 0 ? 28 : 14; }
        }
        bytes = await pdf.save();
      } else {
        if (!args.slides?.length) throw new Error("PPTX creation requires at least one slide");
        const deck = new PptxGenJS(); deck.layout = "LAYOUT_WIDE"; deck.author = "Xyst"; deck.subject = args.title; deck.title = args.title;
        for (const item of args.slides) {
          const slide = deck.addSlide(); slide.background = { color: "0A1012" };
          slide.addText(item.title, { x: 0.7, y: 0.65, w: 12, h: 0.7, fontFace: "Aptos Display", fontSize: 28, bold: true, color: "9BF5C2", margin: 0 });
          slide.addShape(deck.ShapeType.line, { x: 0.7, y: 1.55, w: 11.9, h: 0, line: { color: "37544A", width: 1 } });
          slide.addText(item.body, { x: 0.7, y: 1.9, w: 11.8, h: 4.8, fontFace: "Aptos", fontSize: 18, color: "E6F0EB", breakLine: false, valign: "top", margin: 0.08, paraSpaceAfterPt: 12, fit: "shrink" });
        }
        const data = await deck.write({ outputType: "nodebuffer", compression: true });
        if (!(data instanceof Uint8Array)) throw new Error("PowerPoint generation returned an unsupported output type"); bytes = data;
      }
      const written = await writeNewFile(path, bytes);
      return recalculation ? { ...written, recalculation } : written;
    }
  } };
}
