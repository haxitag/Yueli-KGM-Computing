declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<(input: string | string[], options?: Record<string, unknown>) => Promise<unknown>>;
}
