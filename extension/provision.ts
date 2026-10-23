/**
 * Self-provisions the native side the first time this machine needs a daemon, so installing the package downloads
 * nothing (and needs no npm install-script approval), and a machine that speaks through another one never does.
 *
 * Downloads into ~/.local/share/pi-speak/:
 *   bin/pi-speak                     — prebuilt daemon from the upstream GitHub release
 *   lib/libonnxruntime.{so,dylib}    — ONNX Runtime, passed to the daemon as ORT_DYLIB_PATH
 *   models/kokoro/…                  — Kokoro-82M weights + voices
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ROOT = path.join(homedir(), ".local", "share", "pi-speak");
const RELEASE = "https://github.com/benjaminjamesxyz/pi-speak/releases/download/v0.1.3";
// 1.20.1, upstream's pick, is older than the daemon's ort crate accepts (upstream issue #1).
const ORT_VERSION = "1.30.0";
const MODEL_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1";
const MODELS: [name: string, minBytes: number][] = [
	["kokoro-v1.0.onnx", 300_000_000],
	["voices-v1.0.bin", 25_000_000],
];

function target(): { bin: string; ort: string; ortLib: string } | null {
	const os = platform();
	const cpu = arch();
	if (os === "linux" && cpu === "x64") return { bin: "linux-x64", ort: "linux-x64", ortLib: "libonnxruntime.so" };
	if (os === "linux" && cpu === "arm64") return { bin: "linux-aarch64", ort: "linux-aarch64", ortLib: "libonnxruntime.so" };
	if (os === "darwin" && cpu === "arm64") return { bin: "darwin-arm64", ort: "osx-arm64", ortLib: "libonnxruntime.dylib" };
	if (os === "darwin" && cpu === "x64") return { bin: "darwin-x64", ort: "osx-x64", ortLib: "libonnxruntime.dylib" };
	return null;
}

export function ortLibPath(): string | null {
	const t = target();
	return t ? path.join(ROOT, "lib", t.ortLib) : null;
}

export function hasEspeak(): boolean {
	try {
		execFileSync("espeak-ng", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Downloads to a file of its own and renames it into place, so sessions provisioning at once can't corrupt it. */
async function download(url: string, dest: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	mkdirSync(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.${process.pid}.tmp`;
	try {
		await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
		renameSync(tmp, dest);
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Returns the daemon binary, downloading whatever is missing first. `log` hears about each download. */
export async function provision(log: (message: string) => void): Promise<string> {
	const t = target();
	if (!t) throw new Error(`pi-speak has no build for ${platform()}-${arch()}`);

	const lib = path.join(ROOT, "lib", t.ortLib);
	if (!existsSync(lib)) {
		log(`downloading ONNX Runtime ${ORT_VERSION} ...`);
		const name = `onnxruntime-${t.ort}-${ORT_VERSION}`;
		const tarball = path.join(ROOT, `${name}.${process.pid}.tgz`);
		const unpacked = path.join(ROOT, `${name}.${process.pid}`);
		try {
			await download(`https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/${name}.tgz`, tarball);
			mkdirSync(unpacked, { recursive: true });
			execFileSync("tar", ["xzf", tarball, "-C", unpacked]);
			// The unversioned name is a symlink to the versioned library; copying follows it.
			mkdirSync(path.dirname(lib), { recursive: true });
			copyFileSync(path.join(unpacked, name, "lib", t.ortLib), `${lib}.${process.pid}.tmp`);
			renameSync(`${lib}.${process.pid}.tmp`, lib);
		} finally {
			rmSync(tarball, { force: true });
			rmSync(unpacked, { recursive: true, force: true });
		}
	}

	for (const [name, minBytes] of MODELS) {
		const dest = path.join(ROOT, "models", "kokoro", name);
		if (existsSync(dest) && statSync(dest).size >= minBytes * 0.9) continue;
		log(`downloading ${name} (~${Math.round(minBytes / 1e6)} MB) ...`);
		await download(`${MODEL_BASE}/${name}`, dest);
	}

	const bin = path.join(ROOT, "bin", "pi-speak");
	if (!existsSync(bin)) {
		log("downloading the pi-speak daemon ...");
		await download(`${RELEASE}/pi-speak-${t.bin}`, bin);
		execFileSync("chmod", ["0755", bin]);
	}
	return bin;
}
