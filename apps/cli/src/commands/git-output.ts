/**
 * Remove only the line ending git adds after a single value such as `rev-parse --show-toplevel`.
 * On Unix that is exactly one LF: a directory may itself end in a space or a carriage return, and stripping
 * either would name a different (sibling) path. Git for Windows may end the line with CRLF, and Windows paths
 * cannot contain CR, so CRLF is only removed there.
 */
export function gitValue(stdout: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32" && stdout.endsWith("\r\n")) return stdout.slice(0, -2);
	return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}
