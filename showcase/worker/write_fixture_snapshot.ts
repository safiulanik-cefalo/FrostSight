// Writes public/snapshot.json from the worker fixture, so the app has data before a real snapshot exists.
import { writeFileSync, readFileSync } from "node:fs";
import { shapeState, type GoldRows } from "./src/shape";

const rows = JSON.parse(readFileSync(new URL("./fixtures/gold_rows.json", import.meta.url), "utf8")) as GoldRows;
const state = { ...shapeState(rows, "2026-10-12T09:28:00Z"), source: "snapshot" as const };
writeFileSync(new URL("../public/snapshot.json", import.meta.url), JSON.stringify(state, null, 2) + "\n");
console.log("wrote public/snapshot.json");
