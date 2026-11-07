// The only file screens import UI primitives from. Today it points at the local stand-ins; when `lane/console-style`
// lands (src/ui/index.ts), change this one line to `export * from "./ui/index.ts";` and delete src/standins/.
export * from "./standins/index.tsx";
