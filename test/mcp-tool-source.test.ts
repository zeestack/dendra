import { describe, it, expect } from "vitest";
import {
  initDendra,
  toToolSource,
  mergeToolsets,
  createMcpToolSource,
  s,
  type RouterRecord,
  type McpClientLike,
} from "../src/index.ts";

const { route } = initDendra();

const router = {
  math: {
    add: route
      .input(s.object({ a: s.number(), b: s.number() }))
      .ai({ description: "add two numbers" })
      .handler(({ input }) => input.a + input.b),
  },
} satisfies RouterRecord;

// A fake external MCP server (structurally an MCP client). Returns JSON text,
// exactly like a real server over tools/call.
function fakeMcpClient(): McpClientLike {
  return {
    async listTools() {
      return {
        tools: [
          {
            name: "weather.get",
            description: "Get weather for a city",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
          {
            name: "boom",
            description: "Always errors",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    },
    async callTool({ name, arguments: args }) {
      if (name === "boom") {
        return { content: [{ type: "text", text: "kaboom" }], isError: true };
      }
      const city = (args as { city?: string })?.city ?? "?";
      return {
        content: [{ type: "text", text: JSON.stringify({ city, tempC: 21 }) }],
      };
    },
  };
}

describe("external MCP tools as a ToolSource", () => {
  it("lists remote tools and parses JSON results", async () => {
    const remote = await createMcpToolSource(fakeMcpClient(), { format: "plain" });
    expect(remote.names.sort()).toEqual(["boom", "weather.get"]);
    expect(await remote.execute("weather.get", { city: "Paris" })).toEqual({
      city: "Paris",
      tempC: 21,
    });
  });

  it("throws on an MCP isError result", async () => {
    const remote = await createMcpToolSource(fakeMcpClient());
    await expect(remote.execute("boom", {})).rejects.toThrow(/kaboom/);
  });

  it("supports a prefix (stripped before the remote call)", async () => {
    const remote = await createMcpToolSource(fakeMcpClient(), { prefix: "ext." });
    expect(remote.names).toContain("ext.weather.get");
    expect(await remote.execute("ext.weather.get", { city: "Rome" })).toEqual({
      city: "Rome",
      tempC: 21,
    });
  });

  it("merges local + remote tools into one dispatcher", async () => {
    const local = toToolSource(router, {}, { format: "plain" });
    const remote = await createMcpToolSource(fakeMcpClient(), { format: "plain" });
    const merged = mergeToolsets(local, remote);

    const names = (merged.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.sort()).toEqual(["boom", "math.add", "weather.get"]);

    // Routed to the local procedure…
    expect(await merged.execute("math.add", { a: 2, b: 3 })).toBe(5);
    // …and to the remote MCP server, transparently.
    expect(await merged.execute("weather.get", { city: "Oslo" })).toEqual({
      city: "Oslo",
      tempC: 21,
    });
  });

  it("rejects duplicate tool names across sources", async () => {
    const a = toToolSource(router, {}, { format: "plain" });
    const b = toToolSource(router, {}, { format: "plain" });
    expect(() => mergeToolsets(a, b)).toThrow(/duplicate tool name/);
  });
});
