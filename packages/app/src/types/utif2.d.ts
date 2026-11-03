declare module "utif2" {
  export type Directory = {
    [tag: `t${number}`]: number[] | undefined
    width?: number
    height?: number
    data?: Uint8Array<ArrayBuffer>
  }

  const utif: {
    decode(input: ArrayBuffer, options?: { parseMN: boolean }): Directory[]
    decodeImage(input: ArrayBuffer, page: Directory, pages?: Directory[]): void
    toRGBA8(page: Directory): Uint8Array<ArrayBuffer>
    encode(pages: Directory[]): ArrayBuffer
    encodeImage(data: ArrayBuffer, width: number, height: number, metadata?: Directory): ArrayBuffer
  }
  export default utif
}
