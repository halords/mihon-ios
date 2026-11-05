export class ProtoReader {
  private pos = 0;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  // Reads a field tag; returns [fieldNumber, wireType].
  readTag(): [number, number] {
    const v = this.readVarint();
    return [Number(v >> 3n), Number(v & 7n)];
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;

    for (;;) {
      if (this.pos >= this.buf.length) {
        throw new Error('Unexpected end of protobuf data');
      }

      const byte = this.buf[this.pos]!;
      this.pos += 1;
      result |= BigInt(byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) return result;

      shift += 7n;
      if (shift > 70n) throw new Error('Varint too long');
    }
  }

  readBytes(): Uint8Array {
    const len = Number(this.readVarint());
    if (len < 0 || this.pos + len > this.buf.length) {
      throw new Error('Invalid length-delimited field');
    }

    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  readString(): string {
    return new TextDecoder('utf-8').decode(this.readBytes());
  }

  readFloat32(): number {
    if (this.pos + 4 > this.buf.length) {
      throw new Error('Unexpected end of protobuf data');
    }

    const view = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
      4,
    );
    const value = view.getFloat32(0, true);
    this.pos += 4;
    return value;
  }

  skipField(wire: number): void {
    switch (wire) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2: {
        const len = Number(this.readVarint());
        this.pos += len;
        return;
      }
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
}

export function readPackedVarints(bytes: Uint8Array): bigint[] {
  const reader = new ProtoReader(bytes);
  const out: bigint[] = [];
  while (!reader.done) out.push(reader.readVarint());
  return out;
}
