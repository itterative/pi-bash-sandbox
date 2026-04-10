import { Api, Model } from "@mariozechner/pi-ai";
import { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Get API key and headers for a model, handling both old and new API.
 */
export async function getModelCredentials(
    ctx: ExtensionContext,
    model: Model<Api>,
): Promise<{ apiKey: string; headers: Record<string, string> | undefined }> {
    let apiKey: string | undefined;
    let headers: Record<string, string> | undefined;

    try {
        // @ts-ignore - before 0.63
        apiKey = await ctx.modelRegistry.getApiKey(model);
    } catch {
        const apiKeyAndHeaders = await ctx.modelRegistry.getApiKeyAndHeaders(model);

        if (!apiKeyAndHeaders.ok) {
            throw new Error("Failed to retrieve model key and headers");
        }

        apiKey = apiKeyAndHeaders.apiKey;
        headers = apiKeyAndHeaders.headers;
    }

    return { apiKey: apiKey!, headers };
}
