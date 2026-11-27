import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Miniflare } from "miniflare";

const scratch = mkdtempSync(path.join(tmpdir(), "mf-emfile-"));

if (process.env.EXHAUST) {
	const filler = spawn(process.execPath, ["exhaust-fsevents.js"], { stdio: ["ignore", "pipe", "inherit"] });
	process.on("exit", () => filler.kill());
	await once(filler.stdout, "data");
	console.log("FSEvents stream table exhausted by a separate process");
}

const mf = new Miniflare({
	unsafeDevRegistryPath: path.join(scratch, "registry"),
	workers: [
		{
			name: "a",
			modules: true,
			compatibilityDate: "2026-08-01",
			script: "export default { fetch: () => new Response('ok') }",
			// A binding to a worker outside this instance makes Miniflare watch the dev registry.
			serviceBindings: { B: { name: "b" } },
		},
	],
});

await mf.ready;
console.log("Miniflare ready");
const res = await mf.dispatchFetch("http://localhost/");
console.log("fetch:", res.status, await res.text());
await mf.dispose();
console.log("disposed cleanly");
process.exit(0);
