// macOS allows ~1024 FSEvents streams per machine; fsevents opens one per watch().
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fsevents from "fsevents";

const dir = mkdtempSync(path.join(tmpdir(), "fsevents-filler-"));
for (let i = 0; i < 1100; i++) fsevents.watch(dir, () => {});
console.log("ready");
setInterval(() => {}, 1 << 30);
