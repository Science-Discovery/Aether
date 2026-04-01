import { describe, expect, test } from "bun:test"
import { invalidateFromWatcher } from "./watcher"

describe("file watcher invalidation", () => {
  test("reloads open files and refreshes loaded parent on add", () => {
    const loads: string[] = []
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: (path) => path === "src/new.ts",
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(loads).toEqual(["src/new.ts"])
    expect(refresh).toEqual(["src"])
  })

  test("reloads files that are open in tabs", () => {
    const loads: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/open.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/open.ts",
        loadFile: (path) => loads.push(path),
        node: () => ({
          path: "src/open.ts",
          type: "file",
          name: "open.ts",
          absolute: "/repo/src/open.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: () => {},
      },
    )

    expect(loads).toEqual(["src/open.ts"])
  })

  test("refreshes only changed loaded directory nodes", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/src/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual(["src"])
  })

  test("ignores invalid or git watcher updates", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: ".git/index.lock",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => true,
        loadFile: () => {
          throw new Error("should not load")
        },
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "project.updated",
        properties: {},
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })

  test("refreshes root when file added at root level", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "new-file.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: (path) => path === "",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([""])
  })

  test("walks up to nearest loaded ancestor for deeply nested new file", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/components/ui/button.tsx",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual(["src"])
  })

  test("closes tab on unlink event", () => {
    const closed: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/deleted.ts",
          event: "unlink",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/deleted.ts",
        loadFile: () => {},
        closeFile: (path) => closed.push(path),
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: () => {},
      },
    )

    expect(closed).toEqual(["src/deleted.ts"])
  })
})
