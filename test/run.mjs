// Test entrypoint: import every *.test.mjs, then run the harness.
import "./worker.test.mjs";
import "./coloring.test.mjs";
import "./events.test.mjs";
import "./history.test.mjs";
import "./sw.test.mjs";
import "./theme.test.mjs";
import "./chart.test.mjs";
import { run } from "./harness.mjs";

await run();
