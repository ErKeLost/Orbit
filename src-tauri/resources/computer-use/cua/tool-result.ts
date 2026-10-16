export type McpContent = { type: string; text?: string; mimeType?: string; data?: string; [key: string]: unknown }

/** One tool result, normalised away from whatever transport produced it. */
export type ToolResult = {
  /** Parsed JSON payload when the driver returned JSON. */
  value: Record<string, unknown>
  /** Raw text, for diagnostics. */
  text: string
  images: McpContent[]
  isError: boolean
  errorCode?: string
}
