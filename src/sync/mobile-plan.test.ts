import { describe, expect, it } from "vitest";
import { buildMobileMergePlan } from "./mobile-plan";

describe("buildMobileMergePlan", () => {
  it("reports no changes when local and remote equal the base", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, { "a.md": "1" }, { "a.md": "1" });
    expect(plan).toEqual({
      desiredFiles: { "a.md": "1" },
      conflicts: [],
      localApplyPaths: [],
      remoteChangePaths: []
    });
  });

  it("pushes a local-only edit", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, { "a.md": "2" }, { "a.md": "1" });
    expect(plan.desiredFiles).toEqual({ "a.md": "2" });
    expect(plan.conflicts).toEqual([]);
    expect(plan.localApplyPaths).toEqual([]);
    expect(plan.remoteChangePaths).toEqual(["a.md"]);
  });

  it("pulls a remote-only edit", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, { "a.md": "1" }, { "a.md": "2" });
    expect(plan.desiredFiles).toEqual({ "a.md": "2" });
    expect(plan.conflicts).toEqual([]);
    expect(plan.localApplyPaths).toEqual(["a.md"]);
    expect(plan.remoteChangePaths).toEqual([]);
  });

  it("merges edits to different paths", () => {
    const plan = buildMobileMergePlan(
      { "a.md": "1", "b.md": "1" },
      { "a.md": "2", "b.md": "1" },
      { "a.md": "1", "b.md": "2" }
    );
    expect(plan.desiredFiles).toEqual({ "a.md": "2", "b.md": "2" });
    expect(plan.conflicts).toEqual([]);
    expect(plan.localApplyPaths).toEqual(["b.md"]);
    expect(plan.remoteChangePaths).toEqual(["a.md"]);
  });

  it("accepts identical concurrent edits", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, { "a.md": "2" }, { "a.md": "2" });
    expect(plan.desiredFiles).toEqual({ "a.md": "2" });
    expect(plan.conflicts).toEqual([]);
    expect(plan.localApplyPaths).toEqual([]);
    expect(plan.remoteChangePaths).toEqual([]);
  });

  it("stops on divergent same-path edits", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, { "a.md": "2" }, { "a.md": "3" });
    expect(plan.conflicts).toEqual(["a.md"]);
  });

  it("propagates a local deletion when remote is unchanged", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, {}, { "a.md": "1" });
    expect(plan.desiredFiles).toEqual({});
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteChangePaths).toEqual(["a.md"]);
  });

  it("propagates a remote deletion when local is unchanged", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, { "a.md": "1" }, {});
    expect(plan.desiredFiles).toEqual({});
    expect(plan.conflicts).toEqual([]);
    expect(plan.localApplyPaths).toEqual(["a.md"]);
  });

  it("conflicts when one side deletes and the other edits", () => {
    const plan = buildMobileMergePlan({ "a.md": "1" }, {}, { "a.md": "2" });
    expect(plan.conflicts).toEqual(["a.md"]);
  });
});
