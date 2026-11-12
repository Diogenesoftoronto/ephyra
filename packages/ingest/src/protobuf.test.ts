import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { decodeOtlpProtobuf, encodeOtlpResponse, MemorySignalStore, otlpRoutes, parseOtlp } from "./index.ts";
import type { Signal } from "@ephyra/core";

// Wire fixtures encoded independently of the production decoder. Field numbers follow
// https://github.com/open-telemetry/opentelemetry-proto/tree/v1.5.0/opentelemetry/proto
const uint = (n: bigint): number[] => {
	const out: number[] = [];
	do {
		const b = Number(n & 127n);
		n >>= 7n;
		out.push(b | (n ? 128 : 0));
	} while (n);
	return out;
};
const msg = (field: number, bytes: number[]) => [...uint(BigInt(field * 8 + 2)), ...uint(BigInt(bytes.length)), ...bytes];
const str = (field: number, text: string) => msg(field, [...new TextEncoder().encode(text)]);
const num = (field: number, value: number) => [...uint(BigInt(field * 8)), ...uint(BigInt(value))];
const fixed = (field: number, value: bigint) => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, value, true);
	return [...uint(BigInt(field * 8 + 1)), ...bytes];
};
const kv = (key: string, value: string) => [...str(1, key), ...msg(2, str(1, value))];
const resource = [
	...msg(1, kv("service.name", "mobile")),
	...msg(1, kv("service.version", "1.2.3")),
	...msg(1, kv("os.type", "android")),
	...msg(1, kv("secret", "token=private")),
];
const time = 1700000000123456789n;
const envelope = (record: number[]) => new Uint8Array(msg(1, [...msg(1, resource), ...msg(2, msg(2, record))]));
const log = (text = "mobile crash") =>
	envelope([
		...fixed(1, time),
		...num(2, 17),
		...msg(5, str(1, text)),
		...msg(
			9,
			Array.from({ length: 16 }, (_, i) => i + 1),
		),
		...msg(10, Array(8).fill(17)),
	]);
const app = (maxBodyBytes = 10000) => {
	const signals: Signal[] = [];
	return {
		signals,
		routes: otlpRoutes({
			store: new MemorySignalStore(),
			maxBodyBytes,
			quota: () => true,
			onNewSignal: (signal) => {
				signals.push(signal);
			},
		}),
	};
};
const request = (body: Uint8Array, extra: Record<string, string> = {}) => ({
	method: "POST",
	body,
	headers: { "content-type": "application/x-protobuf", ...extra },
});

test("binary mobile logs retain precise timestamps, trace IDs and redacted resource context", async () => {
	const { routes, signals } = app();
	const response = await routes.request("/v1/logs", request(log()));
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/x-protobuf");
	expect((await response.arrayBuffer()).byteLength).toBe(0);
	expect(signals[0]).toMatchObject({
		service: "mobile",
		message: "mobile crash",
		firstSeen: "2023-11-14T22:13:20.123Z",
		traceId: "0102030405060708090a0b0c0d0e0f10",
		spanId: "1111111111111111",
		attributes: { "os.type": "android", "service.version": "1.2.3", secret: "[REDACTED]" },
	});
	await routes.request("/v1/logs", request(log()));
	expect(signals).toHaveLength(1);
});

test("binary trace errors and exception events preserve request counting", async () => {
	const span = [
		...str(5, "/checkout"),
		...num(6, 2),
		...fixed(7, time),
		...msg(15, num(3, 2)),
		...msg(11, [...fixed(1, time), ...str(2, "exception"), ...msg(3, kv("exception.message", "declined"))]),
	];
	const parsed = parseOtlp(decodeOtlpProtobuf(envelope(span), "traces"), "traces");
	expect(parsed.requests).toEqual([{ route: "/checkout", error: true, at: new Date("2023-11-14T22:13:20.123Z") }]);
	expect(parsed.signals[0]?.message).toBe("declined");
	const { routes, signals } = app();
	expect((await routes.request("/v1/traces", request(envelope(span)))).status).toBe(200);
	expect(signals).toHaveLength(1);
});

test("unknown fields are skipped; malformed wires are rejected without storing anything", async () => {
	const { routes, signals } = app();
	const extended = new Uint8Array([...log(), ...str(100, "future field")]);
	expect((await routes.request("/v1/logs", request(extended))).status).toBe(200);
	for (const body of [[0], [10, 255, 255], [8, 1], [10, 5, 1], [10, ...Array(11).fill(255)], [...log().slice(0, -1)]]) {
		const response = await routes.request("/v1/logs", request(new Uint8Array(body)));
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toBe("application/x-protobuf");
	}
	expect(signals).toHaveLength(1);
});

test("gzip supports both encodings with expanded and wire byte limits", async () => {
	const { routes, signals } = app();
	expect((await routes.request("/v1/logs", request(gzipSync(log()), { "content-encoding": "gzip" }))).status).toBe(200);
	const json = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityNumber: 17, body: { stringValue: "json error" } }] }] }] };
	expect(
		(
			await routes.request(
				"/v1/logs",
				request(gzipSync(JSON.stringify(json)), { "content-encoding": "gzip", "content-type": "application/json" }),
			)
		).status,
	).toBe(200);
	expect(signals).toHaveLength(2);
	const limited = app(500);
	expect((await limited.routes.request("/v1/logs", request(log("x".repeat(1000))))).status).toBe(413);
	expect((await limited.routes.request("/v1/logs", request(gzipSync(log("x".repeat(10000))), { "content-encoding": "gzip" }))).status).toBe(
		413,
	);
	expect((await routes.request("/v1/logs", request(new Uint8Array([1, 2]), { "content-encoding": "gzip" }))).status).toBe(400);
	expect((await routes.request("/v1/logs", request(log(), { "content-encoding": "br" }))).status).toBe(415);
	expect(limited.signals).toHaveLength(0);
});

test("nested AnyValue and field floods have bounded decoding", () => {
	let value = str(1, "deep");
	for (let i = 0; i < 40; i++) value = msg(5, msg(1, value));
	expect(() => decodeOtlpProtobuf(envelope(msg(5, value)), "logs")).toThrow();
	expect(() => decodeOtlpProtobuf(new Uint8Array(Array.from({ length: 100001 }, () => msg(1, [])).flat()), "logs")).toThrow();
});

test("protobuf partial success encodes the rejected count and diagnostic message", () => {
	expect([...encodeOtlpResponse(1)]).toEqual(msg(1, [...num(1, 1), ...str(2, "Some records were rejected")]));
});

test("log bodies survive wire round trips and timestamps retain all 64 bits", () => {
	fc.assert(
		fc.property(fc.string({ maxLength: 1000 }), fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), (text, nanos) => {
			const body = envelope([...fixed(1, nanos), ...msg(5, str(1, text))]);
			const decoded = decodeOtlpProtobuf(body, "logs") as {
				resourceLogs: { scopeLogs: { logRecords: { timeUnixNano: string; body: { stringValue: string } }[] }[] }[];
			};
			const item = decoded.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
			expect(item.timeUnixNano).toBe(String(nanos));
			expect(item.body.stringValue).toBe(text);
		}),
	);
});
