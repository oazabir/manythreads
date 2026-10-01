export class PluginError extends Error {
  override readonly name = 'PluginError';
  readonly plugin: string | undefined;
  constructor(message: string, options: { plugin?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.plugin = options.plugin;
  }
}
