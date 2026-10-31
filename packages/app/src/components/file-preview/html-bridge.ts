export type HtmlOutput = { html: string; deps: string[]; missing: number; blocked: number }
export type HtmlRequest =
  | { type: "render"; path: string; source: string }
  | { type: "resource"; id: number; data: ArrayBuffer; mime: string }
  | { type: "failure"; id: number; message: string }
export type HtmlResponse =
  | { type: "read"; id: number; path: string }
  | { type: "done"; result: HtmlOutput }
  | { type: "error"; message: string }
