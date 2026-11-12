/**
 * OTLP wire fields from opentelemetry-proto v1.5.0, common/resource/logs/trace
 * and collector export messages. Unknown fields are skipped for forward compatibility.
 * This deliberately decodes only the fields consumed by our normalizer, not arbitrary protobuf.
 */
type Field = readonly [name: string, type: string, repeated?: boolean];
type Schema = Record<number, Field>;
const schemas: Record<string, Schema> = {
  logs: { 1: ["resourceLogs", "resourceLogs", true] },
  traces: { 1: ["resourceSpans", "resourceSpans", true] },
  resourceLogs: { 1: ["resource", "resource"], 2: ["scopeLogs", "scopeLogs", true] },
  resourceSpans: { 1: ["resource", "resource"], 2: ["scopeSpans", "scopeSpans", true] },
  resource: { 1: ["attributes", "keyValue", true] },
  scopeLogs: { 2: ["logRecords", "log", true] },
  scopeSpans: { 2: ["spans", "span", true] },
  keyValue: { 1: ["key", "string"], 2: ["value", "value"] },
  value: { 1: ["stringValue", "string"], 2: ["boolValue", "bool"], 3: ["intValue", "int64"],
    4: ["doubleValue", "double"], 5: ["arrayValue", "array"], 6: ["kvlistValue", "kvlist"], 7: ["bytesValue", "hex"] },
  array: { 1: ["values", "value", true] },
  kvlist: { 1: ["values", "keyValue", true] },
  log: { 1: ["timeUnixNano", "fixed64"], 2: ["severityNumber", "number"], 3: ["severityText", "string"],
    5: ["body", "value"], 6: ["attributes", "keyValue", true], 9: ["traceId", "hex"],
    10: ["spanId", "hex"], 11: ["observedTimeUnixNano", "fixed64"] },
  span: { 1: ["traceId", "hex"], 2: ["spanId", "hex"], 5: ["name", "string"], 6: ["kind", "number"],
    7: ["startTimeUnixNano", "fixed64"], 8: ["endTimeUnixNano", "fixed64"], 9: ["attributes", "keyValue", true],
    11: ["events", "event", true], 15: ["status", "status"] },
  event: { 1: ["timeUnixNano", "fixed64"], 2: ["name", "string"], 3: ["attributes", "keyValue", true] },
  status: { 2: ["message", "string"], 3: ["code", "number"] },
};
const utf8 = new TextDecoder("utf-8", { fatal: true });
const invalid = (): never => { throw new Error("Invalid OTLP protobuf"); };

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) return invalid();
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  varint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.take(1)[0]!;
      if (i === 9 && byte > 1) return invalid();
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    return invalid();
  }
  lengthDelimited() { return this.take(Number(this.varint())); }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.take(8);
    else if (wire === 2) this.lengthDelimited();
    else if (wire === 5) this.take(4);
    else invalid(); // OTLP schemas have no deprecated protobuf groups.
  }
}

/** Body size is checked before decoding. Depth and field budgets also bound object expansion. */
export function decodeOtlpProtobuf(bytes: Uint8Array, kind: "logs" | "traces"): unknown {
  let remainingFields = 100_000;
  const decode = (data: Uint8Array, schema: Schema, depth: number): Record<string, unknown> => {
    if (depth > 32) return invalid();
    const reader = new Reader(data);
    const result: Record<string, unknown> = Object.create(null);
    while (reader.offset < data.length) {
      if (--remainingFields < 0) return invalid();
      const tag = reader.varint();
      if (tag > 0xffffffffn || tag < 8n) return invalid();
      const field = schema[Number(tag >> 3n)], wire = Number(tag & 7n);
      if (!field) { reader.skip(wire); continue; }
      const [name, type, repeated] = field;
      const expected = ["bool", "number", "int64"].includes(type) ? 0
        : ["fixed64", "double"].includes(type) ? 1 : 2;
      if (wire !== expected) return invalid();
      let value: unknown;
      if (wire === 0) {
        const raw = reader.varint();
        value = type === "int64" ? BigInt.asIntN(64, raw).toString() : type === "bool" ? raw !== 0n : Number(raw);
        if (type === "number" && !Number.isSafeInteger(value)) return invalid();
      } else if (wire === 1) {
        const raw = reader.take(8), view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        value = type === "double" ? view.getFloat64(0, true) : view.getBigUint64(0, true).toString();
      } else {
        const raw = reader.lengthDelimited();
        value = type === "string" ? utf8.decode(raw) : type === "hex" ? Buffer.from(raw).toString("hex")
          : decode(raw, schemas[type]!, depth + 1);
      }
      if (repeated) {
        const values = (result[name] ??= []) as unknown[];
        values.push(value);
      }
      else result[name] = value;
    }
    return result;
  };
  return decode(bytes, schemas[kind]!, 0);
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function stringField(tag: number, value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [tag, ...varint(bytes.length), ...bytes];
}
/** ExportLogsServiceResponse and ExportTraceServiceResponse share the same wire layout. */
export function encodeOtlpResponse(rejected: number): Uint8Array {
  if (!rejected) return new Uint8Array();
  const partial = [8, ...varint(rejected), ...stringField(18, "Some records were rejected")];
  return new Uint8Array([10, ...varint(partial.length), ...partial]);
}
/** google.rpc.Status, used by OTLP/HTTP for non-200 responses. */
export function encodeOtlpError(code: number, message: string): Uint8Array {
  return new Uint8Array([8, ...varint(code), ...stringField(18, message)]);
}
