// Bracket access keeps server environment variables runtime-resolvable on Vercel.
export function runtimeEnv(name: string) { return process.env[name]; }
