export const delay = (ms) => new Promise((res) => setTimeout(res, ms));

export async function withRetry(fn, retries = 5, delayMs = 1000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn(`⏳ Rate limited. Retrying in ${delayMs}ms...`);
        await delay(delayMs);
        delayMs *= 2;
        attempt++;
      } else {
        throw error;
      }
    }
  }
  throw new Error("❌ Failed after maximum retries.");
}
