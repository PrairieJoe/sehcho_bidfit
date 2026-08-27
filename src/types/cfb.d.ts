declare module "cfb" {
  const CFB: { read(data: Buffer, options: { type: string }): { FileIndex: Array<{ name: string; content: Uint8Array }> } };
  export = CFB;
}
