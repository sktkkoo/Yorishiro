import { describe, expect, it } from "vitest";
import { extractBundledYoriThumbnail } from "./fetch-assets.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function glbWithVrm0Thumbnail(image = PNG) {
  const root = {
    extensions: { VRM: { meta: { texture: 0 } } },
    textures: [{ source: 0 }],
    images: [{ bufferView: 0, mimeType: "image/png" }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.length }],
  };
  const source = Buffer.from(JSON.stringify(root));
  const jsonLength = Math.ceil(source.length / 4) * 4;
  const binLength = Math.ceil(image.length / 4) * 4;
  const output = Buffer.alloc(12 + 8 + jsonLength + 8 + binLength, 0x20);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  source.copy(output, 20);
  const binHeader = 20 + jsonLength;
  output.writeUInt32LE(binLength, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  image.copy(output, binHeader + 8);
  return output;
}

describe("extractBundledYoriThumbnail", () => {
  it("extracts the embedded VRM 0.x PNG", () => {
    expect(extractBundledYoriThumbnail(glbWithVrm0Thumbnail())).toEqual(PNG);
  });

  it("rejects a non-image payload even when metadata claims PNG", () => {
    expect(() => extractBundledYoriThumbnail(glbWithVrm0Thumbnail(Buffer.from("not png")))).toThrow(
      "not a PNG",
    );
  });
});
