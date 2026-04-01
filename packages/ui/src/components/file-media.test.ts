import { describe, expect, test } from "bun:test"
import {
  clampPage,
  clampZoom,
  defaultZoom,
  maxZoom,
  minZoom,
  nextPage,
  prevPage,
  zoomIn,
  zoomOut,
  zoomStep,
} from "./file-media"

describe("PDF page navigation", () => {
  test("clampPage returns 1 for values below minimum", () => {
    expect(clampPage(0, 10)).toBe(1)
    expect(clampPage(-1, 10)).toBe(1)
  })

  test("clampPage clamps to totalPages", () => {
    expect(clampPage(11, 10)).toBe(10)
    expect(clampPage(100, 10)).toBe(10)
  })

  test("clampPage returns page when in range", () => {
    expect(clampPage(1, 10)).toBe(1)
    expect(clampPage(5, 10)).toBe(5)
    expect(clampPage(10, 10)).toBe(10)
  })

  test("clampPage with single page document", () => {
    expect(clampPage(1, 1)).toBe(1)
    expect(clampPage(2, 1)).toBe(1)
  })

  test("nextPage advances by one", () => {
    expect(nextPage(3, 10)).toBe(4)
  })

  test("nextPage stays at last page", () => {
    expect(nextPage(10, 10)).toBe(10)
    expect(nextPage(15, 10)).toBe(10)
  })

  test("prevPage goes back by one", () => {
    expect(prevPage(5, 10)).toBe(4)
  })

  test("prevPage stays at first page", () => {
    expect(prevPage(1, 10)).toBe(1)
    expect(prevPage(0, 10)).toBe(1)
  })
})

describe("PDF zoom controls", () => {
  test("defaultZoom is 1", () => {
    expect(defaultZoom).toBe(1)
  })

  test("zoomIn increases by step", () => {
    const z = zoomIn(1)
    expect(z).toBeGreaterThan(1)
    expect(z).toBeCloseTo(1 + zoomStep, 2)
  })

  test("zoomIn clamps at maxZoom", () => {
    const z = zoomIn(maxZoom)
    expect(z).toBe(maxZoom)
  })

  test("zoomOut decreases by step", () => {
    const z = zoomOut(1)
    expect(z).toBeLessThan(1)
    expect(z).toBeCloseTo(1 - zoomStep, 2)
  })

  test("zoomOut clamps at minZoom", () => {
    const z = zoomOut(minZoom)
    expect(z).toBe(minZoom)
  })

  test("clampZoom enforces bounds", () => {
    expect(clampZoom(0)).toBe(minZoom)
    expect(clampZoom(5)).toBe(maxZoom)
    expect(clampZoom(1.5)).toBe(1.5)
  })

  test("zoom step is reasonable", () => {
    expect(zoomStep).toBeGreaterThan(0)
    expect(zoomStep).toBeLessThan(0.5)
  })

  test("minZoom allows zooming out", () => {
    expect(minZoom).toBeLessThan(1)
    expect(minZoom).toBeGreaterThan(0)
  })

  test("maxZoom allows zooming in", () => {
    expect(maxZoom).toBeGreaterThan(1)
  })
})