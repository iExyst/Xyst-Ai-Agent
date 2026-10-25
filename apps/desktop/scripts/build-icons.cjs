const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

async function main() {
  const directory = join(__dirname, "..", "resources");
  const svg = readFileSync(join(directory, "xyst-icon.svg"));
  const image = await loadImage(svg);
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => {
    const canvas = createCanvas(size, size);
    canvas.getContext("2d").drawImage(image, 0, 0, size, size);
    return { size, data: canvas.toBuffer("image/png") };
  });
  writeFileSync(join(directory, "xyst-icon.png"), images.at(-1).data);

  const directoryBytes = Buffer.alloc(6 + images.length * 16);
  directoryBytes.writeUInt16LE(0, 0);
  directoryBytes.writeUInt16LE(1, 2);
  directoryBytes.writeUInt16LE(images.length, 4);
  let offset = directoryBytes.length;
  for (let index = 0; index < images.length; index++) {
    const { size, data } = images[index];
    const entry = 6 + index * 16;
    directoryBytes[entry] = size === 256 ? 0 : size;
    directoryBytes[entry + 1] = size === 256 ? 0 : size;
    directoryBytes[entry + 2] = 0;
    directoryBytes[entry + 3] = 0;
    directoryBytes.writeUInt16LE(1, entry + 4);
    directoryBytes.writeUInt16LE(32, entry + 6);
    directoryBytes.writeUInt32LE(data.length, entry + 8);
    directoryBytes.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  }
  writeFileSync(join(directory, "xyst-icon.ico"), Buffer.concat([directoryBytes, ...images.map((item) => item.data)]));
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
