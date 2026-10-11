// Safety net: the MCP SDK's HTTP transport can reject a background stream promise
// (e.g. on a 401 for the server→client SSE channel). Node 22 terminates the
// process on an unhandled rejection, which would kill the dev server mid-connect.
// Log it instead of crashing, and surface it so we can see the real cause.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    process.on("unhandledRejection", (reason) => {
      console.error("[unhandledRejection]", reason);
    });
  }
}
