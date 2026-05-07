import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Random } from "effect";
import { TestClock } from "effect/testing";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const projectId = ProjectId.make("project-clock");
const createdAt = "2026-01-01T00:00:00.000Z";
const zeroRandomService = {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0,
};

it.effect("uses the Effect clock for generated project update timestamps", () =>
  Effect.gen(function* () {
    const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
      sequence: 1,
      eventId: EventId.make("evt-project-clock"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: createdAt,
      commandId: CommandId.make("cmd-project-clock-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-clock-create"),
      metadata: {},
      payload: {
        projectId,
        title: "Clock",
        workspaceRoot: "/tmp/clock",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    });

    yield* TestClock.adjust(Duration.seconds(5));
    const expectedNow = DateTime.formatIso(yield* DateTime.now);
    const result = yield* decideOrchestrationCommand({
      command: {
        type: "project.meta.update",
        commandId: CommandId.make("cmd-project-clock-update"),
        projectId,
        title: "Clock Updated",
      },
      readModel,
    });
    const events = Array.isArray(result) ? [...result] : [result];
    assert.lengthOf(events, 1);
    const event = events[0];
    if (!event) {
      assert.fail("expected a project meta-updated event");
      return;
    }
    if (event.type !== "project.meta-updated") {
      assert.fail(`expected project.meta-updated, received ${event.type}`);
      return;
    }

    assert.equal(event.occurredAt, expectedNow);
    assert.equal(event.eventId, EventId.make("00000000-0000-4000-8000-000000000000"));
    assert.equal(event.payload.updatedAt, expectedNow);
  }).pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(Random.Random, zeroRandomService),
  ),
);
