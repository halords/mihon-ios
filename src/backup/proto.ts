export class ProtoReader {
  private pos = 0;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get done(): boolean {
    return this.pos === this.buf.length;
  }

  private advance(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.buf.length - this.pos) {
      throw new Error('Truncated or invalid protobuf field');
    }
    this.pos += length;
  }

  // Reads a field tag; returns [fieldNumber, wireType].
  readTag(): [number, number] {
    const v = this.readVarint();
    const field = Number(v >> 3n);
    const wire = Number(v & 7n);
    if (field < 1 || field > 0x1fffffff || ![0, 1, 2, 5].includes(wire)) {
      throw new Error('Invalid protobuf tag; this is not a Mihon backup');
    }
    return [field, wire];
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
      if (shift === 63n && byte > 1) throw new Error('Protobuf varint exceeds 64 bits');
      result |= BigInt(byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) return result;

      shift += 7n;
      if (shift > 63n) throw new Error('Varint too long');
    }
  }

  // Kotlin Long uses two's-complement varints; source IDs must not lose precision.
  readInt64(): bigint { return BigInt.asIntN(64, this.readVarint()); }
  readInt32(): number { return Number(BigInt.asIntN(32, this.readVarint())); }

  readBytes(): Uint8Array {
    const len = Number(this.readVarint());
    const start = this.pos;
    this.advance(len);
    const out = this.buf.subarray(start, this.pos);
    return out;
  }

  readString(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.readBytes());
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
    if (!Number.isFinite(value)) throw new Error('Invalid number in backup');
    return value;
  }

  skipField(wire: number): void {
    switch (wire) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.advance(8);
        return;
      case 2: {
        const len = Number(this.readVarint());
        this.advance(len);
        return;
      }
      case 5:
        this.advance(4);
        return;
      default:
        throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
}

export function readPackedVarints(bytes: Uint8Array): bigint[] {
  const reader = new ProtoReader(bytes);
  const out: bigint[] = [];
  while (!reader.done) out.push(reader.readInt64());
  return out;
}
