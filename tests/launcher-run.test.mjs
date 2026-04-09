import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeLaunchArgs } from "../src/launcher/run.mjs";

test("buildClaudeLaunchArgs prepends session-only plugin dirs", () => {
  assert.deepEqual(
    buildClaudeLaunchArgs({
      pluginDirs: ["/tmp/plugin-a", " ", null, "/tmp/plugin-b"],
      args: ["--print", "hello"],
    }),
    [
      "--plugin-dir",
      "/tmp/plugin-a",
      "--plugin-dir",
      "/tmp/plugin-b",
      "--print",
      "hello",
    ],
  );
});
