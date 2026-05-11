#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

class InvalidProviderCompatibilityJsonError extends Data.TaggedError(
  "InvalidProviderCompatibilityJsonError",
)<{
  readonly cause: unknown;
}> {}

export const mirrorProviderCompatibilityMap = Effect.fn("mirrorProviderCompatibilityMap")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const sourcePath = path.join(repoRoot, "provider-compatibility.v1.json");
    const destinationPath = path.join(
      repoRoot,
      "apps",
      "marketing",
      "public",
      "provider-compatibility.v1.json",
    );

    const source = yield* fs.readFileString(sourcePath);
    yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: (cause) => new InvalidProviderCompatibilityJsonError({ cause }),
    });

    yield* fs.makeDirectory(path.dirname(destinationPath), { recursive: true });
    yield* fs.copyFile(sourcePath, destinationPath);

    yield* Console.log(
      `Mirrored ${path.relative(repoRoot, sourcePath)} to ${path.relative(repoRoot, destinationPath)}.`,
    );
  },
);

if (import.meta.main) {
  mirrorProviderCompatibilityMap().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
